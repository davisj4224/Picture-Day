export function projectEmailOptions(projects) {
  return projects.map((project) => ({
    ...project,
    displayName: project.archived_at ? `${project.name} (Archived)` : project.name
  }));
}

export function createProjectEmailSelectionGuard() {
  let version = 0;
  return {
    begin(projectId) {
      return { projectId: String(projectId || ''), version: ++version };
    },
    isCurrent(request, selectedProjectId) {
      return request.version === version && request.projectId === String(selectedProjectId || '');
    }
  };
}
