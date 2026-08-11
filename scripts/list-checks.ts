// Prints the registry's check names as a JSON array, for a workflow matrix.
// An unknown name is an error rather than an empty matrix: a dispatch that
// silently qualifies nothing reads exactly like one that qualified everything.
import { checks } from '../src/checks/registry.ts';

const known = [...checks.keys()].sort();
const requested = process.argv[2];

if (requested === undefined || requested === '' || requested === 'all') {
  console.log(JSON.stringify(known));
  process.exit(0);
}

const names = requested.split(',').map((name) => name.trim()).filter((name) => name !== '');
const unknown = names.filter((name) => !known.includes(name));
if (unknown.length > 0) {
  console.error(`unknown check(s): ${unknown.join(', ')}`);
  console.error(`known checks: ${known.join(', ')}`);
  process.exit(2);
}
console.log(JSON.stringify([...new Set(names)].sort()));
