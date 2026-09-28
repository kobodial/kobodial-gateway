CREATE TABLE `pin_attempts` (
	`phone_hash` text PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
