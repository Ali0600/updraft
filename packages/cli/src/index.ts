import { Command } from 'commander';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('ota')
    .description('Publish over-the-air updates to a self-hosted Expo Updates protocol server')
    .version('0.0.0');
  return program;
}

// Only parse when executed as a binary, so tests can import buildProgram freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  buildProgram().parse(process.argv);
}
