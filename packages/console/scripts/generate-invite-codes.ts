#!/usr/bin/env node

const crypto = require('crypto');

/**
 * Generate a random 6-digit integer
 * @returns {string} A 6-digit integer as a string
 */
function generateSixDigitCode() {
  // Generate a random number between 100000 and 999999 (inclusive)
  const min = 100000;
  const max = 999999;
  const randomBytes = crypto.randomBytes(4);
  const randomNumber = randomBytes.readUInt32BE(0);
  const code = min + (randomNumber % (max - min + 1));
  return code.toString();
}

/**
 * Generate multiple unique invite codes
 * @param {number} count - Number of codes to generate
 * @returns {string[]} Array of unique 6-digit codes
 */
function generateMultipleCodes(count) {
  const codes = new Set();
  while (codes.size < count) {
    codes.add(generateSixDigitCode());
  }
  return Array.from(codes);
}

/**
 * Format codes for different outputs
 */
function formatCodes(codes, format) {
  switch (format) {
    case 'env':
      // Format for environment variable
      return codes.join(',');
    case 'array':
      // Format as JavaScript array
      return JSON.stringify(codes, null, 2);
    case 'lines':
      // One code per line
      return codes.join('\n');
    default:
      return codes.join(', ');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const count = parseInt(args[0]) || 10;
const format = args[1] || 'default';

// Generate codes
const codes = generateMultipleCodes(count);

// Output based on format
console.log(`Generated ${count} invite codes:\n`);

switch (format) {
  case 'env':
    console.log('For environment variable:');
    console.log(`VALID_INVITE_CODES=${formatCodes(codes, 'env')}`);
    break;
  case 'array':
    console.log('As JavaScript array:');
    console.log(formatCodes(codes, 'array'));
    break;
  case 'lines':
    console.log(formatCodes(codes, 'lines'));
    break;
  default:
    console.log(formatCodes(codes, 'default'));
    console.log('\nOther formats:');
    console.log(`  Environment variable: ${args[0]} env`);
    console.log(`  JavaScript array: ${args[0]} array`);
    console.log(`  One per line: ${args[0]} lines`);
}