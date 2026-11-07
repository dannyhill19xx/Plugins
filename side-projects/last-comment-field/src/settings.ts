import { kvs } from '@forge/kvs';
import { Settings, sanitizeSettings } from './core';

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  return sanitizeSettings(await kvs.get(KEY));
}

export async function saveSettings(input: unknown): Promise<Settings> {
  const settings = sanitizeSettings(input);
  await kvs.set(KEY, settings);
  return settings;
}
