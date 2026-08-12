-- Where a model's price came from.
--
-- Prices are inferred from the model name, the same way tiers are, because most
-- OpenAI-compatible endpoints answer /v1/models with an id and nothing else. A
-- price corrected by hand has to survive a refresh, so its origin is recorded:
-- refreshing re-infers only rows that are still carrying a guess.
--
-- Existing rows: a price already present came from the provider itself; a null
-- price is left null and will be filled in by the next refresh.
ALTER TABLE `models` ADD `price_source` text;
--> statement-breakpoint
UPDATE `models` SET `price_source` = 'provider'
  WHERE `price_in_per_mtok` IS NOT NULL OR `price_out_per_mtok` IS NOT NULL;
