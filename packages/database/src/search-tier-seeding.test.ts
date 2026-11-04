/**
 * Tests for free-tier seeding and the bulk "use free tier" toggle.
 *
 * Runs against an in-memory SQLite database with the real schema and the real
 * repository, so the column plumbing (`tier`) is exercised end to end.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { SearchProviderRepository } from "./repositories/search-provider.repository";
import {
	seedFreeSearchProviders,
	setFreeSearchTiersEnabled,
} from "./search-tier-seeding";

describe("search tier seeding", () => {
	let db: Database;
	let repository: SearchProviderRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new SearchProviderRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("seeds the free rows disabled, at last-resort priority, with no key", async () => {
		await seedFreeSearchProviders(repository);

		const rows = await repository.findAll();
		const free = rows.filter((row) => row.tier === "free");
		expect(free.map((row) => row.provider).sort()).toEqual([
			"firecrawl",
			"keenable",
		]);
		for (const row of free) {
			expect(row.enabled).toBe(false);
			expect(row.apiKey).toBeNull();
			expect(row.priority).toBeGreaterThanOrEqual(900);
		}
	});

	it("is idempotent", async () => {
		await seedFreeSearchProviders(repository);
		const again = await seedFreeSearchProviders(repository);

		expect(again).toEqual([]);
		expect(
			(await repository.findAll()).filter((row) => row.tier === "free"),
		).toHaveLength(2);
	});

	it("never overwrites an operator edit to a seeded row", async () => {
		await seedFreeSearchProviders(repository);
		const keenable = (await repository.findAll()).find(
			(row) => row.tier === "free" && row.provider === "keenable",
		);
		if (!keenable) throw new Error("keenable free row not seeded");
		await repository.update(keenable.id, { priority: 0, enabled: true });

		await seedFreeSearchProviders(repository);

		const after = await repository.findById(keenable.id);
		expect(after?.priority).toBe(0);
		expect(after?.enabled).toBe(true);
	});

	it("recognises a renamed free row by its tier and does not duplicate it", async () => {
		await seedFreeSearchProviders(repository);
		const keenable = (await repository.findAll()).find(
			(row) => row.tier === "free" && row.provider === "keenable",
		);
		if (!keenable) throw new Error("keenable free row not seeded");
		await repository.update(keenable.id, { label: "My keyless Keenable" });

		const created = await seedFreeSearchProviders(repository);

		expect(created).toEqual([]);
		expect(
			(await repository.findAll()).filter(
				(row) => row.provider === "keenable" && row.tier === "free",
			),
		).toHaveLength(1);
	});

	it("never toggles a free row that has been given a key (it is paid now)", async () => {
		await seedFreeSearchProviders(repository);
		const keenable = (await repository.findAll()).find(
			(row) => row.tier === "free" && row.provider === "keenable",
		);
		if (!keenable) throw new Error("keenable free row not seeded");
		// Simulate the handler's derivation: a key means paid.
		await repository.update(keenable.id, {
			apiKey: "keen-key",
			tier: "paid",
			enabled: true,
		});

		await setFreeSearchTiersEnabled(repository, false);

		expect((await repository.findById(keenable.id))?.enabled).toBe(true);
	});

	it("never toggles a paid row", async () => {
		await repository.create({
			provider: "keenable",
			label: "Keenable (paid)",
			apiKey: "keen-key",
			priority: 0,
			enabled: true,
		});
		await seedFreeSearchProviders(repository);

		await setFreeSearchTiersEnabled(repository, false);

		const paid = (await repository.findAll()).find(
			(row) => row.label === "Keenable (paid)",
		);
		expect(paid?.enabled).toBe(true);
	});

	it("recreates a free row the operator deleted, still disabled", async () => {
		// Seeding is create-only and identity is the display label, so a
		// deleted free row comes back — disabled and at its default priority,
		// which is exactly the installed-but-off state. To keep it gone, the
		// operator leaves it disabled rather than deleting it.
		await seedFreeSearchProviders(repository);
		const keenable = (await repository.findAll()).find(
			(row) => row.tier === "free" && row.provider === "keenable",
		);
		if (!keenable) throw new Error("keenable free row not seeded");
		await repository.delete(keenable.id);

		const created = await seedFreeSearchProviders(repository);

		expect(created).toEqual(["Keenable (free)"]);
		const restored = (await repository.findAll()).find(
			(row) => row.tier === "free" && row.provider === "keenable",
		);
		expect(restored?.enabled).toBe(false);
	});

	it("coexists with a paid row for the same provider", async () => {
		await repository.create({
			provider: "keenable",
			label: "Keenable (paid)",
			apiKey: "keen-key",
			priority: 0,
		});

		await seedFreeSearchProviders(repository);

		const rows = (await repository.findAll()).filter(
			(row) => row.provider === "keenable",
		);
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => row.tier === "free")).toHaveLength(1);
		expect(await repository.isLabelTaken("Keenable (free)")).toBe(true);
	});

	it("toggles only free rows on and off, leaving paid rows untouched", async () => {
		await repository.create({
			provider: "tavily",
			label: "Tavily (paid)",
			apiKey: "tvly-key",
			priority: 0,
			enabled: false,
		});
		await seedFreeSearchProviders(repository);

		expect(await setFreeSearchTiersEnabled(repository, true)).toHaveLength(2);
		let rows = await repository.findAll();
		expect(
			rows.filter((row) => row.tier === "free").every((row) => row.enabled),
		).toBe(true);
		expect(rows.find((row) => row.label === "Tavily (paid)")?.enabled).toBe(
			false,
		);

		expect(await setFreeSearchTiersEnabled(repository, false)).toHaveLength(2);
		rows = await repository.findAll();
		expect(
			rows.filter((row) => row.tier === "free").every((row) => !row.enabled),
		).toBe(true);

		// Nothing left to change.
		expect(await setFreeSearchTiersEnabled(repository, false)).toHaveLength(0);
	});
});

describe("updateExpectingKey (tier vs concurrent key change)", () => {
	let db: Database;
	let repository: SearchProviderRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new SearchProviderRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("writes when the key has not moved", async () => {
		const row = await repository.create({
			provider: "keenable",
			label: "K",
			apiKey: "k-old",
			tier: "paid",
		});

		const updated = await repository.updateExpectingKey(
			row.id,
			{ priority: 5, tier: "paid" },
			"k-old",
		);

		expect(updated?.priority).toBe(5);
		expect(updated?.tier).toBe("paid");
	});

	it("refuses the write when the key changed since it was read", async () => {
		const row = await repository.create({
			provider: "keenable",
			label: "K",
			apiKey: "k-old",
			tier: "paid",
		});
		// Simulate the interleaving: a tier derived from "k-old" arrives after
		// the key was cleared (the row is free now).
		await repository.update(row.id, { apiKey: null, tier: "free" });

		const result = await repository.updateExpectingKey(
			row.id,
			{ tier: "paid" },
			"k-old",
		);

		expect(result).toBeNull();
		expect((await repository.findById(row.id))?.tier).toBe("free");
	});

	it("refuses a write derived from 'no key' once a key appears", async () => {
		const row = await repository.create({
			provider: "keenable",
			label: "K",
			tier: "free",
		});
		await repository.update(row.id, { apiKey: "k-new", tier: "paid" });

		const result = await repository.updateExpectingKey(
			row.id,
			{ tier: "free" },
			null,
		);

		expect(result).toBeNull();
		expect((await repository.findById(row.id))?.tier).toBe("paid");
	});
});
