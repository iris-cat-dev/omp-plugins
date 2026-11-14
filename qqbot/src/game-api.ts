export interface GameEvent {
  groupId: string;
  userId: string;
  text: string;
  nickname?: string;
  targetId?: string;
  answer?: boolean;
}

export interface ParsedGameInput {
  text: string;
}

export interface GameReviewRequest {
  kind: 'breakthrough' | 'rift';
  requestId: string;
  revision: number;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export interface BreakthroughScore {
  value: 0 | 1 | 2;
  quote: string;
}

export interface BreakthroughReview {
  scores: {
    experience: BreakthroughScore & { factIds: string[] };
    problem: BreakthroughScore;
    reason: BreakthroughScore;
    change: BreakthroughScore;
  };
  feedback: string;
  followUp: string | null;
}

export interface ValidatedBreakthroughReview {
  scores: { experience: number; problem: number; reason: number; change: number };
  total: number;
  passed: boolean;
  probabilityFloor: number;
  feedback: string;
  followUp: string | null;
  evidence: {
    experience: { quote: string; factIds: string[] };
    problem: { quote: string };
    reason: { quote: string };
    change: { quote: string };
  };
}

export interface GameFact {
  id: string;
  type: string;
  [detail: string]: string | number | boolean | null;
}

export interface BreakthroughTrial {
  id: string;
  revision: number;
  fromRealm: number;
  targetRealm: number;
  question: string;
  facts: GameFact[];
  answers: string[];
  status: 'awaiting' | 'judging' | 'qualified' | 'settled' | 'cancelled' | 'rejected';
  protectedAttempt: boolean;
  review: ValidatedBreakthroughReview | null;
  receipts: Array<{ revision: number; message: string }>;
  promptMessage: string;
  lastMessage: string;
  lastAttempt?: { at: number; probability: number; success: boolean; loss: number; protectedAttempt: boolean };
}

export interface Mission {
  name: string;
  kind: string;
  difficulty: string;
  rate: number;
  minutes: number;
  exp: number;
  itemId: string | null;
}

interface ActivityBase {
  label: string;
  startedAt: number;
  finishCommand: string;
}

export type GameActivity =
  | (ActivityBase & { kind: 'closing' })
  | (ActivityBase & { kind: 'mission'; readyAt: number; task: Mission })
  | (ActivityBase & { kind: 'rift'; rift: { name: string; rank: number; time: number } });

export interface RiftAdventure {
  id: string;
  revision: number;
  round: number;
  maxRounds: number;
  status: 'awaiting' | 'judging' | 'settled' | 'cancelled';
  score: number;
  scene: { id: string; title: string; description: string };
  history: Array<{ sceneId: string; action: string; outcome: 'success' | 'mixed' | 'failure'; reason: string; narrative: string }>;
  pendingAction: string | null;
  receipts: Array<{ revision: number; message: string }>;
  promptMessage: string;
  lastMessage: string;
}

export interface Player {
  userId: string;
  name: string;
  root: { type: string; name: string; speed: number };
  realm: number;
  exp: number;
  money: number;
  hp: number;
  mp: number;
  equipment: { weapon: string | null; armor: string | null; technique: string | null; skill: string | null };
  inventory: Record<string, number>;
  activity: GameActivity | null;
  breakthroughAt: number | null;
  breakthroughBonus: number;
  pillBonus: number;
  giftClaims: number;
  giftAt: number | null;
  board: { date: string; entries: Mission[] } | null;
  daily: {
    date: string;
    refreshes: number;
    pillUses: Record<string, number>;
    sectTasks: number;
    sectElixirClaimed: boolean;
    dualCultivations: number;
  };
  createdAt: number;
  attackBonus: number;
  pillTotals: Record<string, number>;
  bossPoints: number;
  lastDuelAt: number | null;
  signDate?: string;
  breakthroughTrial: BreakthroughTrial | null;
  riftAdventure: RiftAdventure | null;
  insightReviews: Array<{ key: string; review: BreakthroughReview }>;
  journey: GameFact[];
  journeySequence: number;
  bank: { balance: number; level: number; lastSettledAt: number } | null;
  estate: { name: string | null; gardenPlots: number; gardenAt: number; minePlots: number; mineAt: number } | null;
  alchemy: {
    collectionLevel: number;
    fireLevel: number;
    exp: number;
    records: Record<string, { name: string; count: number }>;
    exam: { points: number; current: Record<string, unknown> | null };
  };
  romance: {
    favor: Record<string, number>;
    completedSpecial: Record<string, boolean>;
    task: { fairyId: string; day: string; missionId: string; special: boolean; cost: number; acceptedAt: number } | null;
    completedDay: string | null;
    confessionDates: Record<string, string>;
    partnerFairyId: string | null;
  };
  sectId: number | null;
  sectPosition: number | null;
  sectContribution: number;
  attackPractice: number;
  sectTask: Record<string, unknown> | null;
  lastSectTaskRefreshAt: number | null;
  lastStealAt: number | null;
  position: string;
}

export interface GameResult {
  handled: boolean;
  message: string;
  reviewRequest?: GameReviewRequest;
  error?: 'invalid_review' | 'judge_failed';
}

export interface GameReviewEvent {
  groupId: string;
  userId: string;
  kind: 'breakthrough' | 'rift';
  requestId: string;
  revision: number;
  review: unknown;
}

export interface GameOptions {
  databasePath: string;
  now?: () => number;
  random?: () => number;
  judge?: (request: GameReviewRequest) => unknown | Promise<unknown>;
}

export interface Game {
  parseInput(event: GameEvent): ParsedGameInput | null;
  handleCommand(event: GameEvent): GameResult;
  handleMessage(event: GameEvent): Promise<GameResult>;
  resolveReview(event: GameReviewEvent): GameResult;
  getPlayer(groupId: string, userId: string): Player | null;
  close(): void;
}

