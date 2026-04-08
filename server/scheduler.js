const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { getDriver } = require('./drivers');
const notifications = require('./notifications');

const GCODE_DIR = path.join(__dirname, 'gcode');

class JobScheduler extends EventEmitter {
  constructor(db, poller) {
    super();
    this.db = db;
    this.poller = poller;
    this._isSweeping = false;
    this._pendingPrinters = [];
  }

  start() {
    console.log('[scheduler] Starting job scheduler');

    this.poller.on('printerIdle', ({ printer }) => {
      this._dispatchToPrinter(printer).catch((err) =>
        console.error(`[scheduler] Unhandled error dispatching to ${printer.name}:`, err)
      );
    });

    this.poller.on('statusChange', ({ printer, newStatus }) => {
      if (newStatus === 'FINISHED') {
        this._handleFinished(printer);
      }
      if (newStatus === 'ERROR' || newStatus === 'OFFLINE') {
        this._handlePrinterUnavailable(printer);
      }
    });
  }

  // Sweep all currently idle non-held active printers, dispatching in batches of 10.
  // Each batch waits for all jobs to reach printing (or terminal) before the next batch fires.
  // Called when a project is activated or the server starts.
  sweepIdlePrinters() {
    // Include FINISHED printers with is_held = 0 — this state means the operator
    // confirmed the print was good (released the hold) but the upload failed.
    // They need a new job just as much as an IDLE printer does.
    const eligiblePrinters = this.db.prepare(`
      SELECT * FROM printers
      WHERE status IN ('IDLE', 'FINISHED') AND is_held = 0 AND is_active = 1
    `).all();

    console.log(`[scheduler] Sweeping ${eligiblePrinters.length} eligible printer(s) (IDLE or operator-confirmed FINISHED)`);

    if (eligiblePrinters.length === 0) return;

    this._sweepInBatches(eligiblePrinters).catch((err) =>
      console.error('[scheduler] Sweep error:', err)
    );
  }

  async _sweepInBatches(printers) {
    // If a sweep is already running, defer these printers to the end of it.
    // This prevents concurrent sweeps when set-ready-batch is called mid-sweep,
    // and ensures newly-ready printers don't jump the queue.
    if (this._isSweeping) {
      this._pendingPrinters.push(...printers);
      console.log(`[scheduler] Sweep in progress — ${printers.length} printer(s) deferred to end of current sweep`);
      return;
    }

    this._isSweeping = true;
    try {
      let toDispatch = [...printers];
      while (toDispatch.length > 0) {
        const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'dispatch_batch_size'").get();
        const batchSize = setting ? Math.max(1, parseInt(setting.value, 10) || 10) : 10;

        for (let i = 0; i < toDispatch.length; i += batchSize) {
          const batch = toDispatch.slice(i, i + batchSize);
          console.log(`[scheduler] Dispatching batch ${Math.floor(i / batchSize) + 1} — ${batch.length} printer(s)`);

          // Fire all dispatches in this batch concurrently, collect job IDs
          const jobIds = (await Promise.all(
            batch.map(printer =>
              this._dispatchToPrinter(printer).catch(err => {
                console.error(`[scheduler] Sweep dispatch error for ${printer.name}:`, err);
                return null;
              })
            )
          )).filter(id => id != null);

          if (jobIds.length > 0) {
            await this._waitForBatch(jobIds);
          }

          console.log(`[scheduler] Batch ${Math.floor(i / batchSize) + 1} complete — proceeding to next`);
        }

        // Pick up any printers that were deferred while we were sweeping
        toDispatch = this._pendingPrinters.splice(0);
        if (toDispatch.length > 0) {
          console.log(`[scheduler] Processing ${toDispatch.length} deferred printer(s)`);
        }
      }
    } finally {
      this._isSweeping = false;
    }
  }

  // Dispatch a single printer, respecting any in-progress sweep.
  // Use this instead of _dispatchToPrinter directly for set-ready and recommission paths,
  // so that a printer set ready mid-sweep is added to the end of the current batch sequence
  // rather than firing concurrently with it.
  scheduleForPrinter(printer) {
    if (this._isSweeping) {
      this._pendingPrinters.push(printer);
      console.log(`[scheduler] ${printer.name} set ready during sweep — deferred to end of sweep`);
      return;
    }
    this._dispatchToPrinter(printer).catch(err =>
      console.error(`[scheduler] Unhandled error dispatching to ${printer.name}:`, err)
    );
  }

  // Poll jobs table until all given job IDs are printing or terminal (failed/cancelled).
  // Gives up after 10 minutes — large files on slow networks can take several minutes to transfer.
  _waitForBatch(jobIds, pollIntervalMs = 3000, timeoutMs = 600000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const placeholders = jobIds.map(() => '?').join(',');

      const check = () => {
        const rows = this.db.prepare(
          `SELECT status FROM jobs WHERE id IN (${placeholders})`
        ).all(...jobIds);

        const allSettled = rows.every(r =>
          r.status === 'printing' || r.status === 'failed' || r.status === 'cancelled'
        );

        if (allSettled || Date.now() - start > timeoutMs) {
          resolve();
        } else {
          setTimeout(check, pollIntervalMs);
        }
      };

      check();
    });
  }

  // ─── Dispatch ───────────────────────────────────────────────────────────────

  async _dispatchToPrinter(printer) {
    // Re-read is_held from DB — the printer object passed in may be stale
    const fresh = this.db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printer.id);
    if (!fresh || fresh.is_held) {
      console.log(`[scheduler] ${printer.name} is held — skipping dispatch`);
      return null;
    }

    // Find the best open Part that has a G-code for this printer's model,
    // belonging to an active project. FIFO across projects by created_at.
    const candidate = this.db.prepare(`
      SELECT
        parts.id          AS part_id,
        parts.target_qty,
        parts.completed_qty,
        parts.project_id,
        gcodes.id         AS gcode_id,
        gcodes.filename,
        gcodes.filepath,
        gcodes.parts_per_plate
      FROM parts
      JOIN gcodes   ON gcodes.part_id    = parts.id
      JOIN projects ON projects.id       = parts.project_id
      WHERE parts.status    = 'open'
        AND projects.status = 'active'
        AND gcodes.printer_model = ?
      ORDER BY projects.priority ASC, projects.created_at ASC, parts.sort_order ASC, parts.created_at ASC
      LIMIT 1
    `).get(printer.model);

    if (!candidate) {
      console.log(`[scheduler] No candidate found for ${printer.name} (model: ${printer.model}) — no open parts with matching G-code in an active project`);
      return null;
    }

    // Synchronously insert a job as 'uploading' — this acts as a dispatch lock
    // so concurrent printerIdle events for printers of the same model don't
    // over-dispatch the same Part.
    const jobRow = this.db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at)
      VALUES (?, ?, ?, ?, 'uploading', ?)
    `).run(candidate.part_id, printer.id, candidate.gcode_id, candidate.parts_per_plate, Date.now());
    const jobId = jobRow.lastInsertRowid;

    // Ceiling check: how many jobs are still needed vs how many are already active?
    const jobsRemaining = Math.max(
      0,
      Math.ceil((candidate.target_qty - candidate.completed_qty) / candidate.parts_per_plate)
    );
    const activeCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE part_id = ? AND status IN ('uploading', 'printing')
    `).get(candidate.part_id).count;

    if (activeCount > jobsRemaining) {
      // We inserted one too many — Part is already covered
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
      console.log(`[scheduler] Ceiling hit for ${printer.name} — ${activeCount} active jobs already cover ${jobsRemaining} remaining for part ${candidate.part_id}`);
      return null;
    }

    // Resolve the G-code path on disk before invoking the driver.
    // A missing file won't be fixed by retrying, so we bail immediately.
    const driver = getDriver(printer.type);
    const gcodeFilename = candidate.filepath.split(/[\\/]/).pop();
    const gcodeFullPath = path.join(GCODE_DIR, gcodeFilename);
    if (!fs.existsSync(gcodeFullPath)) {
      this.db.prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(jobId);
      this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
      const part = this.db.prepare('SELECT parts.name, projects.name AS project_name FROM parts JOIN projects ON projects.id = parts.project_id WHERE parts.id = ?').get(candidate.part_id);
      notifications.add(
        `G-code file missing for "${candidate.filename}" — re-upload the file for part "${part?.name}" in project "${part?.project_name}". Printer ${printer.name} has been held.`
      );
      return null;
    }

    // Upload with retries. A transient network timeout (common when many printers
    // start simultaneously) will self-heal. Only after all attempts are exhausted
    // does the printer get re-held for operator attention.
    //
    // 409 CONFLICT means a file transfer is already in progress on the printer
    // (typically a previous attempt that timed out on our side but continued on the printer).
    // We wait 60 s before retrying in that case — much longer than the 5 s used for other errors.
    const MAX_RETRIES = 2;
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        await driver.uploadAndPrint(printer, gcodeFullPath, candidate.filename);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt <= MAX_RETRIES) {
          const isConflict = err.code === 'UPLOAD_CONFLICT';
          const waitMs = isConflict ? 60000 : 5000;
          console.warn(
            `[scheduler] ${printer.name} upload attempt ${attempt}/${MAX_RETRIES + 1} failed ` +
            `(${err.message}) — retrying in ${waitMs / 1000}s`
          );
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }

    if (lastErr) {
      // Before giving up, check whether the printer is actually printing.
      // This handles the case where our request timed out but the printer
      // received the file and started the job anyway. If it is printing, treat
      // the upload as a success so the job is tracked correctly.
      const isActuallyPrinting = await driver.checkIfPrinting(printer);
      if (isActuallyPrinting) {
        this.db.prepare(`UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?`).run(Date.now(), jobId);
        console.log(`[scheduler] ${printer.name} upload appeared to fail but printer is printing — job ${jobId} recovered`);
        return jobId;
      }

      this.db.prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(jobId);
      // Re-hold the printer — upload failed, operator must inspect before next dispatch.
      this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
      console.error(`[scheduler] ${printer.name} dispatch failed after ${MAX_RETRIES + 1} attempts: ${lastErr.message}`);
      return null;
    }

    this.db.prepare(`
      UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?
    `).run(Date.now(), jobId);

    console.log(`[scheduler] ${printer.name} ← ${candidate.filename}`);
    return jobId;
  }

  // ─── Finished handling ───────────────────────────────────────────────────────

  _handleFinished(printer) {
    // Find the job currently marked printing for this printer
    const job = this.db.prepare(`
      SELECT * FROM jobs
      WHERE printer_id = ? AND status = 'printing'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(printer.id);

    if (!job) {
      console.warn(`[scheduler] FINISHED on ${printer.name} but no printing job found — may be outside system`);
      // Still try to dispatch the next job
      this._dispatchToPrinter(printer).catch(() => {});
      return;
    }

    const now = Date.now();

    // Mark job finished
    this.db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`)
      .run(now, job.id);

    // Increment completed_qty
    this.db.prepare(`
      UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?
    `).run(job.parts_per_plate, now, job.part_id);

    const part = this.db.prepare('SELECT * FROM parts WHERE id = ?').get(job.part_id);

    console.log(`[scheduler] ${printer.name} finished — Part "${part.name}" ${part.completed_qty}/${part.target_qty}`);

    if (part.completed_qty >= part.target_qty) {
      this._closePart(part, now);
    }

    // Hold the printer — operator must confirm print quality before next job dispatches
    this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
    console.log(`[scheduler] ${printer.name} held — awaiting operator confirmation`);
  }

  _closePart(part, now) {
    this.db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`)
      .run(now, part.id);

    // Cancel any queued (not yet dispatched) jobs for this part
    this.db.prepare(`
      UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'
    `).run(part.id);

    console.log(`[scheduler] Part "${part.name}" closed (${part.completed_qty}/${part.target_qty})`);

    // Check if all parts in the project are now closed
    const openCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'
    `).get(part.project_id).count;

    if (openCount === 0) {
      this.db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`)
        .run(now, part.project_id);
      console.log(`[scheduler] Project ${part.project_id} completed!`);
    }
  }

  // ─── Error / offline handling ────────────────────────────────────────────────

  _handlePrinterUnavailable(printer) {
    // Mark any uploading/printing job on this printer as failed
    const job = this.db.prepare(`
      SELECT * FROM jobs
      WHERE printer_id = ? AND status IN ('uploading', 'printing')
      ORDER BY started_at DESC LIMIT 1
    `).get(printer.id);

    if (job) {
      this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?`)
        .run(Date.now(), job.id);
      console.warn(`[scheduler] Marked job ${job.id} failed — ${printer.name} went ${printer.status}`);
    }

    // Hold the printer — any error or offline state requires operator sign-off.
    // The poller also sets this, but we do it here too for defense in depth.
    this.db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
    console.warn(`[scheduler] ${printer.name} held — entered ${printer.status}, operator confirmation required`);
  }
}

module.exports = JobScheduler;
