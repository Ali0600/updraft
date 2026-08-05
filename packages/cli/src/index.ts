import { Command } from 'commander';
import { appsCommand, rollbackCommand, updatesCommand } from './commands/admin.js';
import { keysCommand } from './commands/keys.js';
import { publishCommand } from './commands/publish.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('updraft')
    .description('Publish over-the-air updates to a self-hosted Expo Updates protocol server')
    .version('0.0.0');

  program.addCommand(publishCommand());
  program.addCommand(keysCommand());
  program.addCommand(appsCommand());
  program.addCommand(updatesCommand());
  program.addCommand(rollbackCommand());

  return program;
}

// Only parse when executed as a binary, so tests can import buildProgram freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
