import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './useAppStore';
import type { Job, Project } from '../types';

const project: Project = {
  id: 'p1',
  name: 'Balcony anchor detail',
  createdAt: '2026-08-14T10:00:00Z',
  status: 'processing',
  photoCount: 42,
};

const job: Job = {
  id: 'j1',
  projectId: 'p1',
  status: 'running',
  stage: 'sfm',
  progress: 30,
  updatedAt: '2026-08-14T10:01:00Z',
};

beforeEach(() => {
  useAppStore.getState().reset();
});

describe('useAppStore', () => {
  it('adds a project once and then merges updates into it', () => {
    const { upsertProject } = useAppStore.getState();

    upsertProject(project);
    upsertProject({ ...project, status: 'ready', splatUrl: 'https://cdn/x.ksplat' });

    const { projects } = useAppStore.getState();
    expect(projects).toHaveLength(1);
    expect(projects[0].status).toBe('ready');
    expect(projects[0].photoCount).toBe(42);
  });

  it('clears the selection when the selected project is removed', () => {
    const store = useAppStore.getState();
    store.upsertProject(project);
    store.selectProject('p1');
    store.removeProject('p1');

    expect(useAppStore.getState().projects).toHaveLength(0);
    expect(useAppStore.getState().selectedProjectId).toBeNull();
  });

  it('indexes the latest job by project', () => {
    useAppStore.getState().upsertJob(job);
    useAppStore.getState().upsertJob({ ...job, stage: 'train', progress: 60 });

    const stored = useAppStore.getState().jobsByProjectId.p1;
    expect(stored.stage).toBe('train');
    expect(stored.progress).toBe(60);
  });
});
