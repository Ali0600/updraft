import { Command } from 'commander';
import { AdminApi } from '../api.js';

const out = (line: string) => process.stdout.write(`${line}\n`);

export function appsCommand(): Command {
  const apps = new Command('apps').description('manage apps on the server');

  apps
    .command('create')
    .description('create an app with its default channels (production, staging)')
    .requiredOption('-s, --server <url>', 'update server origin')
    .requiredOption('--slug <slug>', 'url-safe identifier used in the manifest URL')
    .requiredOption('--name <name>', 'display name')
    .action(async (options: { server: string; slug: string; name: string }) => {
      const app = await new AdminApi(options.server).createApp(options.slug, options.name);
      out(`created app '${app.slug}'`);
      out(`manifest URL: ${options.server.replace(/\/+$/, '')}/api/manifest/${app.slug}`);
    });

  apps
    .command('list')
    .description('list apps')
    .requiredOption('-s, --server <url>', 'update server origin')
    .action(async (options: { server: string }) => {
      const apps = await new AdminApi(options.server).listApps();
      if (apps.length === 0) {
        out('no apps yet — create one with `updraft apps create`');
        return;
      }
      for (const app of apps) out(`${app.slug}\t${app.name}\t${app.createdAt}`);
    });

  return apps;
}

export function updatesCommand(): Command {
  const updates = new Command('updates').description('inspect and manage published updates');

  updates
    .command('list')
    .description('list recent updates (newest first) with their group ids')
    .requiredOption('-s, --server <url>', 'update server origin')
    .requiredOption('-a, --app <slug>', 'app slug')
    .option('-c, --channel <name>', 'filter to one channel')
    .action(async (options: { server: string; app: string; channel?: string }) => {
      const rows = await new AdminApi(options.server).listUpdates(options.app, options.channel);
      if (rows.length === 0) {
        out('no updates published yet');
        return;
      }
      out('groupId\tplatform\truntime\ttype\tstatus\tcreatedAt\tby');
      for (const row of rows) {
        out(
          `${row.groupId}\t${row.platform}\t${row.runtimeVersion}\t${row.type}\t${row.status}\t${row.createdAt}\t${row.publishedBy ?? '-'}`,
        );
      }
    });

  updates
    .command('republish')
    .description('put an earlier publish back in front (find group ids via `updates list`)')
    .requiredOption('-s, --server <url>', 'update server origin')
    .requiredOption('-g, --group-id <id>', 'the publish to bring back')
    .action(async (options: { server: string; groupId: string }) => {
      const result = await new AdminApi(options.server).republish(options.groupId);
      out(`republished as group ${result.groupId} (${result.updates.length} platform(s))`);
    });

  updates
    .command('disable')
    .description('take a publish out of service (clients fall back to the previous one)')
    .requiredOption('-s, --server <url>', 'update server origin')
    .requiredOption('-g, --group-id <id>', 'the publish to disable')
    .action(async (options: { server: string; groupId: string }) => {
      const result = await new AdminApi(options.server).disable(options.groupId);
      out(`disabled ${result.disabled} update row(s)`);
    });

  return updates;
}

export function rollbackCommand(): Command {
  return new Command('rollback')
    .description('tell clients to return to the bundle embedded in their binary')
    .requiredOption('-s, --server <url>', 'update server origin')
    .requiredOption('-a, --app <slug>', 'app slug')
    .requiredOption('-c, --channel <name>', 'channel to roll back')
    .requiredOption('-r, --runtime-version <version>', 'runtime version to roll back')
    .option('-p, --platforms <list>', 'comma-separated subset (default: all)')
    .action(
      async (options: {
        server: string;
        app: string;
        channel: string;
        runtimeVersion: string;
        platforms?: string;
      }) => {
        const result = await new AdminApi(options.server).rollbackToEmbedded(
          options.app,
          options.channel,
          options.runtimeVersion,
          options.platforms?.split(',').map((value) => value.trim()),
        );
        out(`rollback active (group ${result.groupId})`);
        out(
          'undo by republishing a previous group: `updraft updates list` then `updraft updates republish`',
        );
      },
    );
}
