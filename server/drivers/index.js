// Driver registry — maps printer.type → driver module.
// Each driver implements: getStatus, uploadAndPrint, cancelJob, checkIfPrinting.
// Add a new entry here when a new printer brand is supported.

const prusa = require('./prusa');

const DRIVERS = {
  prusa,
};

function getDriver(type) {
  const driver = DRIVERS[type];
  if (!driver) throw new Error(`No driver registered for printer type: "${type}"`);
  return driver;
}

module.exports = { getDriver };
