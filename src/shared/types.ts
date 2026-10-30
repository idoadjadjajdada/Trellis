export const ATOM_TYPES = ['decision', 'fact', 'task', 'idea', 'question'] as const;
export type AtomType = (typeof ATOM_TYPES)[number];

export const ATOM_STATUSES = ['decided', 'proposed'] as const;
export type AtomStatus = (typeof ATOM_STATUSES)[number];

export type ReviewState = 'approved' | 'pending';

/** Display name for atoms that have no project. Not a real project row. */
export const UNSORTED = 'Unsorted';
export const UNSORTED_COLOR = '#8b93a1';

export interface Atom {
  id: string;
  text: string;
  type: AtomType;
  status: AtomStatus;
  reviewState: ReviewState;
  projectId: string | null;
  projectName: string;
  sourceAi: string | null;
  sourceChat: string | null;
  pinned: boolean;
  aiScore: number;
  referenceCount: number;
  /** Importance, 0..1. Drives atom size and the minimum weight filter. */
  weight: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Ids of atoms this one replaces. */
  replaces: string[];
  /** Ids of live atoms that replace this one. Non-empty means this atom is dimmed. */
  replacedBy: string[];
}

export interface Project {
  id: string;
  name: string;
  color: string;
  atomCount: number;
}

export interface GraphLink {
  source: string;
  target: string;
  /** Cosine similarity for similarity links; 1 for replaces links. */
  similarity: number;
  kind: 'similar' | 'replaces';
}

export interface GraphData {
  atoms: Atom[];
  links: GraphLink[];
  projects: Project[];
  linkThreshold: number;
}

export interface Settings {
  duplicateThreshold: number;
  linkThreshold: number;
}

export interface Me {
  id: string;
  displayName: string;
  /** True when signed in with a recovery code: the user must add a passkey first. */
  recovery: boolean;
}

export interface SyncState {
  /** Changes whenever any of the user's atoms or projects change. */
  version: string;
  reviewCount: number;
}
