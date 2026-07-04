CREATE TABLE `job_file_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`file_entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `job`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jfr_role_check" CHECK("job_file_ref"."role" IN ('input', 'mask'))
);
--> statement-breakpoint
CREATE INDEX `jfr_entry_id_idx` ON `job_file_ref` (`file_entry_id`);--> statement-breakpoint
CREATE INDEX `jfr_source_id_idx` ON `job_file_ref` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jfr_unique_idx` ON `job_file_ref` (`file_entry_id`,`source_id`,`role`);