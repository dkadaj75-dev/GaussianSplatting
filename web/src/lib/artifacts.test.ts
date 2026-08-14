import { describe, expect, it } from 'vitest';
import { formatBytes, selectSceneArtifact, viewableArtifacts } from './artifacts';
import type { Artifact } from '../types';

const artifact = (filename: string, format = filename.split('.').pop() ?? '', bytes = 1024): Artifact => ({
  filename,
  format,
  bytes,
});

describe('selectSceneArtifact', () => {
  it('prefers scene.splat over everything else', () => {
    const artifacts = [artifact('output.ply'), artifact('scene.splat'), artifact('scene.ksplat')];
    expect(selectSceneArtifact(artifacts)?.filename).toBe('scene.splat');
  });

  it('prefers scene.splat regardless of listing order', () => {
    const artifacts = [artifact('scene.splat'), artifact('output.ply')];
    expect(selectSceneArtifact([...artifacts].reverse())?.filename).toBe('scene.splat');
  });

  it('falls back to output.ply when no compressed form exists', () => {
    expect(selectSceneArtifact([artifact('output.ply')])?.filename).toBe('output.ply');
  });

  it('falls back through the compressed formats before the raw ply', () => {
    const artifacts = [artifact('output.ply'), artifact('compressed.spz'), artifact('a.ksplat')];
    expect(selectSceneArtifact(artifacts)?.filename).toBe('a.ksplat');
  });

  it('ignores files the viewer cannot display', () => {
    const artifacts = [artifact('report.pdf', 'pdf'), artifact('cameras.txt', 'txt')];
    expect(selectSceneArtifact(artifacts)).toBeNull();
    expect(viewableArtifacts(artifacts)).toEqual([]);
  });

  it('handles an empty, missing or unhelpful listing without throwing', () => {
    expect(selectSceneArtifact([])).toBeNull();
    expect(selectSceneArtifact(undefined)).toBeNull();
    expect(selectSceneArtifact(null)).toBeNull();
  });

  it('derives the format from the filename when the API omitted it', () => {
    expect(selectSceneArtifact([artifact('scene.ksplat', '')])?.filename).toBe('scene.ksplat');
  });

  it('is deterministic between artifacts of equal rank', () => {
    const artifacts = [artifact('b.splat'), artifact('a.splat')];
    expect(viewableArtifacts(artifacts).map((a) => a.filename)).toEqual(['a.splat', 'b.splat']);
  });
});

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});
