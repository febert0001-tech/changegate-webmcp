self.addEventListener("push", event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { return; }
  if (data.version !== 1 || !/^\/transactions\/[0-9a-f-]{36}\/(approval|checks)$/.test(data.path)) return;
  const body = data.kind === "blocked" ? "A refund was blocked. Sign in to review the checks."
    : data.kind === "escalated" ? "An unanswered refund still needs a supervisor."
      : "Sign in to review a refund that needs approval.";
  event.waitUntil(self.registration.showNotification("ChangeGate refund alert",{
    body, tag:data.tag, data:{path:data.path},
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path=event.notification.data?.path;
  if(typeof path==="string" && /^\/transactions\/[0-9a-f-]{36}\/(approval|checks)$/.test(path)) {
    event.waitUntil(self.clients.openWindow(path));
  }
});
