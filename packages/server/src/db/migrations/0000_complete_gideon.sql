CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_slug_unique` ON `apps` (`slug`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256_hex` text NOT NULL,
	`sha256_b64url` text NOT NULL,
	`key` text NOT NULL,
	`content_type` text NOT NULL,
	`file_extension` text,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_hash_key_unique` ON `assets` (`sha256_hex`,`key`);--> statement-breakpoint
CREATE INDEX `assets_hash_idx` ON `assets` (`sha256_hex`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_app_name_unique` ON `channels` (`app_id`,`name`);--> statement-breakpoint
CREATE TABLE `update_assets` (
	`update_id` text NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`update_id`, `asset_id`),
	FOREIGN KEY (`update_id`) REFERENCES `updates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `updates` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`app_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`platform` text NOT NULL,
	`runtime_version` text NOT NULL,
	`type` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`launch_asset_id` text,
	`metadata` text NOT NULL,
	`extra` text,
	`git_commit` text,
	`published_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`launch_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `updates_id_unique` ON `updates` (`id`);--> statement-breakpoint
CREATE INDEX `updates_lookup_idx` ON `updates` (`app_id`,`channel_id`,`platform`,`runtime_version`,`status`);--> statement-breakpoint
CREATE INDEX `updates_group_idx` ON `updates` (`group_id`);