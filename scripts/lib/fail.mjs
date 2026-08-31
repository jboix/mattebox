/** Prints the details and the message, then exits non-zero. Shared by the check scripts. */
export function fail(message, details = []) {
  for (const detail of details) console.error(detail);
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
