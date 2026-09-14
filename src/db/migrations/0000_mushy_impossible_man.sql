CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`from_phone_hash` text,
	`to_phone_hash` text,
	`amount` text,
	`status` text NOT NULL,
	`error_code` text,
	`tx_hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ussd_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`phone_hash` text NOT NULL,
	`step` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_phone_hash_unique` ON `wallets` (`phone_hash`);