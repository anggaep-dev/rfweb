import { RaceGender } from '../rf/character';
import type { BaseAppearance, CharacterAppearance, CharacterProfile, CharacterSummary } from '../rf/characterProfile';
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

/** Full per-character data (base appearance + equipped items + inventory) - fetched once entering the world, not by the (lighter) character-select list. */
export function getCharacterProfile(sessionToken: string, characterId: string): Promise<CharacterProfile> {
  return request<CharacterProfile>(`/characters/${encodeURIComponent(characterId)}`, sessionToken);
}

/** Any account's character can be looked up here (not just your own - see CharacterAppearance's doc comment) - used to render other players' real look instead of a placeholder (see RemoteEntityController). */
export function getCharacterAppearance(sessionToken: string, characterId: string): Promise<CharacterAppearance> {
  return request<CharacterAppearance>(`/characters/${encodeURIComponent(characterId)}/appearance`, sessionToken);
}
