import { RaceGender } from '../rf/character';
import type { BaseAppearance, CharacterSummary } from '../rf/characterProfile';
import { isSecurePage, pageHostname, SERVER_PORT } from './serverHost';

function defaultHttpBase(): string {
  return `${isSecurePage() ? 'https:' : 'http:'}//${pageHostname()}:${SERVER_PORT}`;
}

function httpBase(): string {
  return (import.meta.env.VITE_HTTP_URL as string | undefined) ?? defaultHttpBase();
}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string, sessionToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${httpBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${sessionToken}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** The account's characters (up to MAX_CHARACTERS_PER_ACCOUNT), for the character-select screen. */
export async function listCharacters(sessionToken: string): Promise<CharacterSummary[]> {
  const { characters } = await request<{ characters: CharacterSummary[] }>('/characters', sessionToken);
  return characters;
}

export interface CreateCharacterRequest {
  name: string;
  race: RaceGender;
  baseAppearance: BaseAppearance;
}

/** Fails (409) if the account already has MAX_CHARACTERS_PER_ACCOUNT characters, or (400) if the name is taken/invalid. */
export function createCharacter(sessionToken: string, req: CreateCharacterRequest): Promise<CharacterSummary> {
  return request<CharacterSummary>('/characters', sessionToken, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function deleteCharacter(sessionToken: string, characterId: string): Promise<void> {
  return request<void>(`/characters/${encodeURIComponent(characterId)}`, sessionToken, { method: 'DELETE' });
}
