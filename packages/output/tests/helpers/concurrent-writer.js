// Helper for test-concurrent-write.js — appends one marker line via withLock.
// Invoked as a child process: node concurrent-writer.js <target-path> <id>

const fs = require('fs');
const { withLock } = require('../../../shared/file-lock');

const [, , target, id] = process.argv;
if (!target || id === undefined) {
  console.error('usage: concurrent-writer.js <target> <id>');
  process.exit(2);
}

const result = withLock(target, () => {
  const existing = fs.readFileSync(target, 'utf8');
  const newLine = `worker-${id} done`;
  fs.writeFileSync(target, existing + newLine + '\n', 'utf8');
  return true;
});

process.exit(result ? 0 : 1);
