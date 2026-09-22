export function cli(args = process.argv.slice(2)) {
  function option(name, fallback) {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
    return args[index + 1];
  }
  function positive(name, fallback) {
    const value = Number(option(name, fallback));
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  }
  return { option, positive, flag: name => args.includes(name) };
}
