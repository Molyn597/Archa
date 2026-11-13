import { describe, expect, it } from 'vitest';
import { pickAsset } from '../src/shared/update-asset';

const base = 'https://github.com/Molyn597/Archa/releases/download/v1.2.0/';
const assets = ['mac-universal.dmg', 'mac-universal.zip', 'win-x64.exe', 'win-arm64.exe'].map((n) => ({ name: `Archa-1.2.0-${n}`, url: `${base}Archa-1.2.0-${n}`, size: 1 }));

describe('výběr instalátoru aktualizace', () => {
  it('macOS dostane universal DMG', () => {
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe('Archa-1.2.0-mac-universal.dmg');
    expect(pickAsset(assets, 'darwin', 'x64')?.name).toBe('Archa-1.2.0-mac-universal.dmg');
  });
  it('Windows podle architektury', () => {
    expect(pickAsset(assets, 'win32', 'x64')?.name).toBe('Archa-1.2.0-win-x64.exe');
    expect(pickAsset(assets, 'win32', 'arm64')?.name).toBe('Archa-1.2.0-win-arm64.exe');
  });
  it('jiná platforma nebo chybějící soubor = null', () => {
    expect(pickAsset(assets, 'linux', 'x64')).toBeNull();
    expect(pickAsset(assets.slice(0, 2), 'win32', 'x64')).toBeNull();
  });
  it('odmítne adresu mimo vydání projektu', () => {
    const evil = [{ name: 'Archa-1.2.0-win-x64.exe', url: 'https://evil.example/Archa-1.2.0-win-x64.exe', size: 1 }];
    expect(pickAsset(evil, 'win32', 'x64')).toBeNull();
  });
});
