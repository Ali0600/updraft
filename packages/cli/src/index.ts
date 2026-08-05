import { Command } from 'commander';
import { keysCommand } from './commands/keys.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('updraft')
    .description('Publish over-the-air updates to a self-hosted Expo Updates protocol server')
    .version('0.0.0');

  program.addCommand(keysCommand());

  return program;
}

// Only parse when executed as a binary, so tests can import buildProgram freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    buildProgram().parse(process.argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
