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
