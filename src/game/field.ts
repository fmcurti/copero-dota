import { clamp, gaussian, mulberry32, type Rng } from "./rng";
import type { LuckTrait, SimTeam } from "./types";

// ---------------------------------------------------------------------------
// The tournament field: your team + 17 AI teams with strength ~ N(86, 5)
// clamped to [76, 99]. Rerolling the field just re-seeds this generator.
// ---------------------------------------------------------------------------

export const FIELD_OPPONENTS = 17;
export const SOLO_AI_MEAN = 86;
export const MULTI_AI_MEAN_CAP = SOLO_AI_MEAN + 2;
const AI_SD = 5;
const AI_MIN = 76;
const AI_MAX = 99;

const NAME_PREFIX = [
  "Mid or",
  "Feeding",
  "Tilted",
  "Backdoor",
  "Divine",
  "Salty",
  "Buyback",
  "Eternal",
  "Deranked",
  "Jungling",
  "Cheese",
  "Rampage",
  "Fountain",
  "Smoke",
  "Highground",
  "Throwing",
  "Ancient",
  "Doubledown",
  "Griefing",
  "Turbo",
  "Refresher",
  "Pos Six",
];

const NAME_SUFFIX = [
  "Andromedas",
  "Disasters",
  "Believers",
  "Gamblers",
  "Couriers",
  "Creeps",
  "Illusions",
  "Wards",
  "Rats",
  "Tormentors",
  "Peons",
  "Munchkins",
  "Marmots",
  "Chickens",
  "Techies",
  "Gankers",
  "Stacks",
  "Pubstars",
  "Doomers",
  "Ricers",
  "Wisps",
  "Smurfs",
];

const SPECIAL_NAMES = [
  "No Tinker",
  "No Techies",
  "No Meepo",
  "Pudge Every Game",
  "AM Jungle",
  "Riki Sideways",
  "SF Upside Down",
  "Void Diagonal",
  "WK Roaming",
  "Bane Carry",
  "OD Bench",
  "Chen Gaming",
  "IO Mid",
  "Tusk Backwards",
];

/** Excuses shown when you reroll the opponent field. */
export const FIELD_REROLL_EXCUSES = [
  "Visa Problems",
  "Roster Lock Missed",
  "322 Investigation",
  "Bootcamp Food Poisoning",
  "Team House DDoS'd",
  "Stand-in Needed a Stand-in",
  "Keyboard Lost In Transit",
  "Booth Air Conditioning Too Strong",
  "Anti-cheat Flagged the Coach",
  "Missed The Email",
  "Sponsor Pulled Out Mid-flight",
  "Paused and Never Resumed",
  "Queued Turbo By Accident",
  "Peripherals Stuck In Customs",
];

export function generateTeamNames(rng: Rng, count: number): string[] {
  const names = new Set<string>();
  const specials = [...SPECIAL_NAMES].sort(() => rng() - 0.5);
  const specialCount = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < specialCount && i < specials.length; i++) names.add(specials[i]);
  let guard = 0;
  while (names.size < count && guard++ < 2000) {
    names.add(
      `${NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)]} ${NAME_SUFFIX[Math.floor(rng() * NAME_SUFFIX.length)]}`,
    );
  }
  return [...names].sort(() => rng() - 0.5).slice(0, count);
}

export const FIELD_SIZE = 18;

export interface HumanSeed {
  ownerId: string;
  name: string;
  strength: number;
  /** Per-game luck trait carried by this roster (e.g. musu). */
  luck?: LuckTrait;
}

export function multiplayerAiMean(humans: HumanSeed[]): number {
  const humanMean = Math.round(
    humans.reduce((sum, human) => sum + human.strength, 0) / Math.max(1, humans.length),
  );
  return Math.min(MULTI_AI_MEAN_CAP, humanMean - 4);
}

/**
 * Field for N human teams + (18 − N) AI teams. AI strength scales to the
 * lobby but sits BELOW the human average (mean = avg − 4) so the humans seed
 * high and meet each other in the bracket. The mean is capped at two points
 * above solo difficulty so an exceptional lobby does not make every bot elite.
 * `aiMean` pins it instead (solo pins 86 to keep the original difficulty).
 */
export function generateFieldMulti(
  humans: HumanSeed[],
  fieldSeed: number,
  aiMean?: number,
): SimTeam[] {
  const rng = mulberry32(fieldSeed);
  const mean = aiMean ?? multiplayerAiMean(humans);
  const opponents = generateTeamNames(rng, FIELD_SIZE - humans.length).map((name, i) => ({
    id: `opp${i}`,
    name,
    strength: Math.round(clamp(gaussian(rng, mean, AI_SD), AI_MIN, AI_MAX)),
    isUser: false,
    ownerId: null,
  }));
  const humanTeams = humans.map((h) => ({
    id: `h:${h.ownerId}`,
    name: h.name,
    strength: Math.round(h.strength),
    isUser: false,
    ownerId: h.ownerId,
    ...(h.luck ? { luck: h.luck } : {}),
  }));
  return [...humanTeams, ...opponents];
}

export function generateField(
  userStrength: number,
  teamName: string,
  fieldSeed: number,
  luck?: LuckTrait,
): SimTeam[] {
  return generateFieldMulti(
    [{ ownerId: "solo", name: teamName, strength: userStrength, luck }],
    fieldSeed,
    SOLO_AI_MEAN,
  ).map((t) => (t.ownerId === "solo" ? { ...t, id: "user", isUser: true } : t));
}

/** Where the user seeds in the field, with a ±1 uncertainty band for display. */
export function fieldRank(field: SimTeam[]): { rank: number; low: number; high: number } {
  const rank =
    [...field].sort((a, b) => b.strength - a.strength).findIndex((t) => t.isUser) + 1;
  return { rank, low: Math.max(1, rank - 1), high: Math.min(field.length, rank + 1) };
}
