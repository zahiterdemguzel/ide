const fs = require('fs');

// Write a file so a reader only ever sees the old complete file or the new one:
// a full write to a sibling temp file, then a rename (atomic on one filesystem).
// A plain writeFileSync killed mid-write leaves a truncated file that fails to
// parse next launch — for the remote config that means a freshly minted relay
// room, which silently unpairs every phone.
function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

module.exports = { writeFileAtomic };
