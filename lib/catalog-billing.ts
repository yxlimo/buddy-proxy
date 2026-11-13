// lib/catalog-billing.ts — what an upstream's /models says about billing, in one shape.
//
// Every platform describes price its own way: a flat object per model with
// per-million strings (tokenrhythm), a bare pricing object with no currency and
// no unit (sensenova), per-token USD buried in a modality array (intern-ai), or a
// nested cost tree with time-of-day multipliers (opencode-go). Callers should not
// grow a branch per platform, so the differences live in a descriptor table and
// one reader walks it.
//
// Three of the four are the same object: three roles (input / output / cache read),
// a unit and a currency. Those are pure data in BILLING_DESCRIPTORS. intern-ai
// picks its prices out of arrays by `type`, which a plain path cannot express, so a
// descriptor may carry a `read` hook that returns the same raw shape — the
// normalising and assembling below stays shared. Only the platform that needs it
// fills the hook; the table is deliberately not a generic query language.
//
// Units are normalised here and only here: a per-token price becomes a per-million
// price by ×1e6, because that is the one unit every platform can be compared in.
//
// Discounts are not modelled. tokenrhythm reports has_discount plus discount_* and
// effective_* prices; this reader takes the effective price first and falls back to
// the listed price, so what surfaces is what a request actually costs right now.
// When the panel grows a place to show "was 8, now 4" the original price can be
// added then — until it does, keeping the two would only create a field that
// silently shows the list price for a discounted model.

/** How a model is charged. */
export type BillingMode = "token" | "multiplier" | "none";

/** The currencies the platforms report. Anything else is treated as unreported. */
export type BillingCurrency = "CNY" | "USD";

/**
 * A price's basis as the upstream states it.
 *
 * "unknown" is not "per million by default": without a unit the number cannot be
 * normalised, and guessing one would print a price that is off by six orders of
 * magnitude.
 */
export type BillingUnit = "per_million" | "per_token" | "unknown";

/** One model's billing, platform-independent. */
export interface ModelBilling {
  mode: BillingMode;
  /** Only in token mode; absent when the upstream does not say which currency */
  currency?: BillingCurrency;
  /** Always per million tokens, whatever unit the upstream used */
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  /** Multiplier billing, e.g. ×0.15 */
  credits?: number;
  /** Time-of-day multipliers, copied as the upstream reports them */
  multipliers?: { factor: number; note?: string }[];
  /**
   * The platform answered, but not with a price. Callers show nothing for this
   * model rather than 0 — see the rule in `readModelBilling`
   */
  unknown?: boolean;
  /**
   * This billing came from a person's override, not from the upstream.
   *
   * It states where the value came from, not whether it differs: an override that
   * repeats the upstream's own numbers is still `overridden`. Callers label the
   * price with it; nothing may infer it by comparing values.
   */
  overridden?: boolean;
}

/**
 * The billing a person wrote for one model, before it is checked.
 *
 * Every field is optional: a missing `mode` is "nobody said", which is not the
 * same as `mode: "none"` — that one is a person stating the model is not charged
 * for at all.
 */
export interface BillingOverride {
  mode?: string;
  currency?: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  multiplier?: number;
}

/** The three modes a person may pick. */
const OVERRIDE_MODES: BillingMode[] = ["none", "token", "multiplier"];

/**
 * What is wrong with one billing override, or null when it is fine.
 *
 * The message names the field instead of saying "invalid": a row carries four
 * boxes, and "invalid" alone would leave a person hunting through them.
 */
export function billingOverrideProblem(billing: BillingOverride): string | null {
  if (billing.mode !== undefined && !OVERRIDE_MODES.includes(billing.mode as BillingMode)) {
    return `billing mode is not one of ${OVERRIDE_MODES.join("/")}: ${billing.mode}`;
  }
  if (billing.currency !== undefined) {
    const currency = billing.currency.trim().toUpperCase();
    // Only these two: another code has no symbol and no rate to normalise against,
    // so storing one would just print a string the panel cannot read.
    if (currency !== "CNY" && currency !== "USD") {
      return `billing currency is not CNY/USD: ${billing.currency}`;
    }
  }
  for (const [field, value] of [
    ["inputPerMillion", billing.inputPerMillion],
    ["outputPerMillion", billing.outputPerMillion],
    ["cacheReadPerMillion", billing.cacheReadPerMillion],
    ["multiplier", billing.multiplier],
  ] as [string, number | undefined][]) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `billing ${field} is not a non-negative number: ${String(value)}`;
    }
  }
  return null;
}

/**
 * The billing a person wrote, as the catalogue carries it.
 *
 * `mode` absent means no override at all: the caller keeps whatever it had.
 *
 * Only the fields the chosen mode reads are carried — a price left over from the
 * mode a person switched away from would otherwise sit in the catalogue looking
 * current. Note the two meanings of `none` meeting here: a person writes it for
 * "not charged", while the reader in this file uses it for "nothing to report";
 * `overridden` is what tells them apart downstream.
 */
export function overrideBilling(billing: BillingOverride): ModelBilling | undefined {
  const mode = billing.mode as BillingMode | undefined;
  if (mode === undefined) return undefined;
  if (mode === "none") return { mode: "none", overridden: true };
  if (mode === "multiplier") {
    return billing.multiplier === undefined
      ? { mode: "multiplier", overridden: true }
      : { mode: "multiplier", credits: billing.multiplier, overridden: true };
  }
  const out: ModelBilling = { mode: "token", overridden: true };
  const currency = billing.currency?.trim().toUpperCase();
  if (currency === "CNY" || currency === "USD") out.currency = currency;
  if (billing.inputPerMillion !== undefined) out.inputPerMillion = billing.inputPerMillion;
  if (billing.outputPerMillion !== undefined) out.outputPerMillion = billing.outputPerMillion;
  if (billing.cacheReadPerMillion !== undefined) {
    out.cacheReadPerMillion = billing.cacheReadPerMillion;
  }
  return out;
}

/** The billing roles a descriptor maps paths to. */
type Role = "input" | "output" | "cacheRead";

/** Where the currency comes from: a literal, a field of the model, or nowhere. */
type CurrencySource =
  | { kind: "literal"; value: BillingCurrency }
  | { kind: "field"; paths: string[] }
  | { kind: "none" };

/**
 * What a `read` hook returns. Still in the upstream's own unit — the reader below
 * scales it, so a hook never does arithmetic on prices itself.
 */
export interface RawBillingReading {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** For a platform whose unit differs per model */
  unit?: BillingUnit;
  /** For a platform that states the currency on the model instead of the descriptor */
  currency?: BillingCurrency;
}

/** Everything that differs between platforms. */
export interface BillingDescriptor {
  /** Role to candidate paths, best first (a fallback is tried only if the first is missing) */
  roles: Partial<Record<Role, string[]>>;
  unit: BillingUnit;
  currency: CurrencySource;
  /** Path to a multiplier-billing number */
  credits?: string[];
  /** Path to an array of `{ factor }` time-of-day multipliers */
  multipliers?: string;
  /** Escape hatch for shapes a path cannot express */
  read?: (model: unknown) => RawBillingReading;
}

const TOKENRHYTHM: BillingDescriptor = {
  // effective_* is the price in force now; pricing is the list price it was cut from
  roles: {
    input: ["effective_pricing.prompt", "pricing.prompt"],
    output: ["effective_pricing.completion", "pricing.completion"],
    cacheRead: ["effective_pricing.cache_read", "pricing.cache_read"],
  },
  unit: "per_million",
  currency: { kind: "field", paths: ["effective_pricing.currency", "pricing.currency", "currency"] },
};

const SENSENOVA: BillingDescriptor = {
  roles: {
    input: ["pricing.prompt"],
    output: ["pricing.completion"],
    cacheRead: ["pricing.input_cache_read"],
  },
  // The platform reports neither a unit nor a currency, so there is nothing to
  // normalise against (see the unknown rule below)
  unit: "unknown",
  currency: { kind: "none" },
};

const INTERN_AI: BillingDescriptor = {
  // Prices live in a per-modality array keyed by type, so roles come from the hook
  roles: {},
  unit: "per_token",
  currency: { kind: "literal", value: "USD" },
  read: (model) => {
    const row = model as { input_modalities?: unknown; output_modalities?: unknown } | null;
    const reading: RawBillingReading = {};
    for (const item of pricingItems(row?.input_modalities)) {
      const type = String(item?.type ?? "");
      if (type === "prompt") reading.input = toNumber(item?.cost_usd);
      else if (type === "cached_prompt") reading.cacheRead = toNumber(item?.cost_usd);
    }
    for (const item of pricingItems(row?.output_modalities)) {
      if (String(item?.type ?? "") === "completion") reading.output = toNumber(item?.cost_usd);
    }
    return reading;
  },
};

const OPENCODE_GO: BillingDescriptor = {
  roles: {
    input: ["cost.text.input.price"],
    output: ["cost.text.output.price"],
    cacheRead: ["cost.text.input.cache.read"],
  },
  unit: "per_million",
  // No currency field; this platform prices in dollars
  currency: { kind: "literal", value: "USD" },
  multipliers: "cost.multipliers",
};

/**
 * The platforms whose catalogue carries billing, by the name the rest of the code
 * uses for them. A platform not in here simply has no billing to read.
 */
export const BILLING_DESCRIPTORS: Record<string, BillingDescriptor> = {
  tokenrhythm: TOKENRHYTHM,
  sensenova: SENSENOVA,
  "intern-ai": INTERN_AI,
  "opencode-go": OPENCODE_GO,
};

/** An array of `{ pricing: [...] }` modality entries flattened to their pricing items. */
function pricingItems(modalities: unknown): any[] {
  if (!Array.isArray(modalities)) return [];
  const items: any[] = [];
  for (const modality of modalities) {
    const pricing = (modality as { pricing?: unknown } | null)?.pricing;
    if (Array.isArray(pricing)) items.push(...pricing);
  }
  return items;
}

/**
 * A number from what the upstream sent, or undefined.
 *
 * Upstreams send prices as strings ("8.00000000"), as numbers, and as null or a
 * missing key when they have nothing to say. A bad value is "not reported", never
 * 0: 0 means a free model, and reporting one has to be deliberate
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  // Number("") is 0, which would turn "no price" into "free"
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A value walked out of an upstream JSON body. The shapes differ per platform, so
 * this is the widest thing a body can hold — each reader narrows what it needs
 */
type FieldValue = string | number | boolean | null | Record<string, unknown> | FieldValue[] | undefined;

/** A value at a dotted path, or undefined when any step is missing. */
function at(model: unknown, path: string): FieldValue {
  let current: any = model;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current as FieldValue;
}

/** The first path that yields a number. */
function firstNumber(model: unknown, paths: string[] | undefined): number | undefined {
  for (const path of paths ?? []) {
    const n = toNumber(at(model, path));
    if (n !== undefined) return n;
  }
  return undefined;
}

/** As currencyOf, for a value that may be an unknown string. */
function asCurrency(value: unknown): BillingCurrency | undefined {
  return value === "CNY" || value === "USD" ? value : undefined;
}

function currencyOf(source: CurrencySource, model: unknown): BillingCurrency | undefined {
  if (source.kind === "literal") return source.value;
  if (source.kind === "none") return undefined;
  for (const path of source.paths) {
    const currency = asCurrency(at(model, path));
    if (currency) return currency;
  }
  return undefined;
}

function readMultipliers(model: unknown, path: string | undefined): { factor: number }[] {
  const rows = path ? at(model, path) : undefined;
  if (!Array.isArray(rows)) return [];
  const multipliers: { factor: number }[] = [];
  for (const row of rows) {
    // Only the factor travels: `when` is a nested any/all time-window expression,
    // and inventing a readable note for it would be a second parser for the same
    // data. Whatever display needs it can read `when` where the catalogue is kept
    const factor = toNumber((row as { factor?: unknown } | null)?.factor);
    if (factor !== undefined) multipliers.push({ factor });
  }
  return multipliers;
}

/** A per-token price as a per-million one, minus the binary noise of the scaling. */
function perMillion(value: number, unit: BillingUnit): number {
  if (unit !== "per_token") return value;
  // 0.0000032 × 1e6 is 3.1999999999999997 in binary floating point; a price with
  // twelve significant digits is exact enough and keeps the noise out of the panel
  return Number((value * 1e6).toPrecision(12));
}

/**
 * The two names a platform row carries, for looking its descriptor up.
 *
 * A row has an id and a kind. The kind is the template it was created from, the id
 * is the name the user gave it — `PLATFORM_KIND_OPTIONS` leaves `presetId` empty for
 * these platforms, so the id is nobody's fixed string. Some platforms need no help:
 * tokenrhythm, sensenova and intern-ai are kinds of their own, and those match by
 * kind whatever the row is called. `opencode-go` is the case that forces the id:
 * it is a row with kind `openai` (the OpenAI dialect) and its own base_url, and the
 * kind says nothing about whose models are behind it — only the id names the vendor.
 * So the id is tried first and the kind is the fallback, in one place, rather than
 * each caller guessing.
 */
export interface BillingSubject {
  /** The platform row's id. Absent when a parser inside a platform module only knows its kind. */
  id?: string;
  /** The kind (template) the row was created from. */
  kind: string;
}

/** The descriptor a platform row points at, or undefined when it has no billing to read. */
export function descriptorFor(subject: BillingSubject): BillingDescriptor | undefined {
  if (subject.id) {
    const byId = BILLING_DESCRIPTORS[subject.id];
    if (byId) return byId;
  }
  return BILLING_DESCRIPTORS[subject.kind];
}

/**
 * Read one model's billing for a platform row.
 *
 * The entry point callers use: it resolves the row's two names (see
 * `BillingSubject`) and hands the reading to the same reader below. A platform with
 * no descriptor is `mode: "none"` — most models have no price to report, which is
 * normal rather than an error.
 */
export function billingFor(subject: BillingSubject, model: unknown): ModelBilling {
  const descriptor = descriptorFor(subject);
  return descriptor ? readBilling(descriptor, model) : { mode: "none" };
}

/**
 * Read one model's billing by the platform's name.
 *
 * `platform` is a name the descriptor table knows (`tokenrhythm`, `sensenova`, ...);
 * an unknown one, or a model with no billing fields, is `mode: "none"` — a model
 * without a price is normal, not an error. Platform rows go through `billingFor`
 * instead: they carry two names, not one (see `BillingSubject`).
 *
 * The rule that matters: **0 is not free unless the platform says so.** A platform
 * that reports no currency and no unit and has every role at 0 has not priced the
 * model at all (sensenova answers exactly that for every model) — so the answer is
 * `unknown: true` with no price fields, and the panel shows nothing. A platform
 * that names the currency and the unit and says 0 has a genuinely free model
 * (tokenrhythm could), and 0 is reported as 0 with no `unknown`. The same holds for
 * a per-token price with no unit: without a unit it cannot be scaled, so it is
 * reported as unknown rather than as a number six orders of magnitude wrong.
 */
export function readModelBilling(platform: string, model: unknown): ModelBilling {
  const descriptor = BILLING_DESCRIPTORS[platform];
  return descriptor ? readBilling(descriptor, model) : { mode: "none" };
}

/** The reader itself: one descriptor, one model. */
function readBilling(descriptor: BillingDescriptor, model: unknown): ModelBilling {
  const extra = descriptor.read ? descriptor.read(model) : {};
  const unit = extra.unit ?? descriptor.unit;
  const currency = extra.currency ?? currencyOf(descriptor.currency, model);

  // The hook and the paths are two ways to the same three roles: whichever found a
  // role wins, so a platform can use both (a path for some roles, a hook for one)
  const input = extra.input ?? firstNumber(model, descriptor.roles.input);
  const output = extra.output ?? firstNumber(model, descriptor.roles.output);
  const cacheRead = extra.cacheRead ?? firstNumber(model, descriptor.roles.cacheRead);
  const credits = firstNumber(model, descriptor.credits);
  const multipliers = readMultipliers(model, descriptor.multipliers);
  const roles = [input, output, cacheRead];
  const priced = roles.some((value) => value !== undefined);

  if (!priced) {
    // A model can be billed purely by multiplier; a bare factor still says something
    if (credits !== undefined) {
      return multipliers.length ? { mode: "multiplier", credits, multipliers } : { mode: "multiplier", credits };
    }
    return multipliers.length ? { mode: "multiplier", multipliers } : { mode: "none" };
  }

  const allZero = roles.every((value) => value === undefined || value === 0);
  const unsupportedUnit = unit === "unknown";
  // Both halves are "the platform did not say enough to state a price": no unit at
  // all, or no currency on an all-zero reply (which is how a platform says it has no
  // price to give, not that the model is free)
  const unstated = unsupportedUnit || (currency === undefined && allZero);
  if (unstated) return { mode: "token", unknown: true };

  const billing: ModelBilling = { mode: "token" };
  if (currency) billing.currency = currency;
  if (input !== undefined) billing.inputPerMillion = perMillion(input, unit);
  if (output !== undefined) billing.outputPerMillion = perMillion(output, unit);
  if (cacheRead !== undefined) billing.cacheReadPerMillion = perMillion(cacheRead, unit);
  if (credits !== undefined) billing.credits = credits;
  if (multipliers.length) billing.multipliers = multipliers;
  return billing;
}
