/**
 * TipTap Test Database Isolation Helper (SEC-02 Remediation)
 *
 * Provides guaranteed database isolation for automated test execution:
 * 1. Seeds an isolated database in the OS temporary directory (os.tmpdir()) from clean baseline.
 * 2. Assigns a unique, non-colliding TIPTAP_DB_FILE path to each test suite and child process.
 * 3. Registers process-level cleanup hooks (exit, SIGINT, SIGTERM) to prevent lingering temp files.
 * 4. Ensures the master repository database (data/tiptap-db.json) is never modified during test execution.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BASE_DB_PATH = path.resolve(__dirname, '../data/tiptap-db.json');

/**
 * Creates an isolated temporary database file in the OS temporary directory.
 *
 * @param {string} suiteName - Descriptive prefix for the test suite
 * @returns {{ tempDbPath: string, cleanup: Function, getInitialRaw: Function }}
 */
function createIsolatedTestDb(suiteName = 'tiptap-test') {
  if (!fs.existsSync(BASE_DB_PATH)) {
    throw new Error(`Baseline database not found at: ${BASE_DB_PATH}`);
  }

  const safePrefix = String(suiteName).replace(/[^a-zA-Z0-9_-]/g, '-');
  const uniqueSuffix = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const filename = `${safePrefix}-${uniqueSuffix}.json`;
  const tempDbPath = path.join(os.tmpdir(), filename);

  // Seed the temporary database file from the pristine baseline
  fs.copyFileSync(BASE_DB_PATH, tempDbPath);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch (e) {
        // Ignore unlinking errors during abrupt process exit
      }
    }
  }

  // Register safety lifecycle hooks
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(1); });
  process.once('SIGTERM', () => { cleanup(); process.exit(1); });

  return {
    tempDbPath,
    cleanup,
    getInitialRaw: () => fs.readFileSync(BASE_DB_PATH, 'utf8')
  };
}

module.exports = {
  createIsolatedTestDb,
  BASE_DB_PATH
};
