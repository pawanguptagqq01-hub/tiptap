/**
 * TipTap Master Automated Test Runner
 * Executes all 8 Phase 1 regression, security, durability, and concurrency suites.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Ensure child processes have non-default production PIN unless explicitly overridden by test
process.env.SUPER_ADMIN_PIN = process.env.SUPER_ADMIN_PIN || 'ProdSecr3t#991';

const dbPath = path.resolve(__dirname, '../data/tiptap-db.json');
const masterBackupPath = path.resolve(__dirname, '../data/tiptap-db.json.master-runner.bak');

function getDbHash() {
  if (!fs.existsSync(dbPath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
}

const initialDbHash = getDbHash();
if (fs.existsSync(dbPath)) {
  fs.copyFileSync(dbPath, masterBackupPath);
}

const testSuites = [
  'tests/phase1-critical-remediation.test.js',
  'tests/concurrency-integrity.test.js',
  'tests/production-durability.test.js',
  'tests/production-resilience.test.js',
  'tests/auth-rbac.test.js',
  'tests/security-audit-phase1.test.js',
  'tests/remediation-phase1.test.js',
  'tests/guest-workflows.test.js',
  'tests/security-remediation-batch1.test.js',
  'tests/phase8-security-remediation.test.js',
  'tests/phase10-payment-automation.test.js'
];

console.log('================================================================');
console.log('🚀 TIPTAP MASTER TEST RUNNER — ALL PHASE 1 SUITES');
console.log('================================================================\n');

let totalSuites = testSuites.length;
let passedSuites = 0;
let failedSuites = 0;

try {
  for (const suite of testSuites) {
    console.log(`\n▶️  RUNNING: ${suite}`);
    console.log('----------------------------------------------------------------');
    const start = Date.now();
    const res = spawnSync('node', [suite], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env
    });
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    if (res.status === 0) {
      console.log(`✅ [SUITE PASSED]: ${suite} (${duration}s)`);
      passedSuites++;
    } else {
      console.error(`❌ [SUITE FAILED]: ${suite} with exit code ${res.status} (${duration}s)`);
      failedSuites++;
    }
  }
} finally {
  const postTestHash = getDbHash();
  const dbRemainedUntouched = initialDbHash === postTestHash;
  if (!dbRemainedUntouched) {
    console.error('❌ CRITICAL SECURITY ERROR: data/tiptap-db.json was MUTATED by test suites!');
    if (fs.existsSync(masterBackupPath)) {
      try {
        fs.copyFileSync(masterBackupPath, dbPath);
      } catch (e) {}
    }
    failedSuites++;
  } else {
    console.log('\n🛡️  ISOLATION VERIFIED: data/tiptap-db.json remained 100% UNTOUCHED (zero disk mutations)');
  }
  if (fs.existsSync(masterBackupPath)) {
    try {
      fs.unlinkSync(masterBackupPath);
    } catch (e) {}
  }
}

console.log('\n================================================================');
console.log(`🏁 MASTER TEST SUMMARY: ${passedSuites}/${totalSuites} SUITES PASSED`);
if (failedSuites > 0) {
  console.error(`🚨 ${failedSuites} SUITES FAILED!`);
  process.exit(1);
} else {
  console.log('🎉 ALL TEST SUITES PASSED CLEANLY WITH 100% SUCCESS!');
  process.exit(0);
}
