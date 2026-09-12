// History contains only an opaque position. Filters and supplier identifiers
// stay in this page's memory and are discarded when the page/account changes.
export function createNavigation({ window: win, snapshot, restore, blocked, dismissOverlay }) {
  let entries = [], position = 0, session = "", returning = false;
  const marker = index => ({ ksaNavigation: { session, index } });
  const copy = value => structuredClone(value);
  const remember = () => { if (entries.length) entries[position] = copy(snapshot()); };
  const reset = () => {
    session = win.crypto.randomUUID();
    entries = [copy(snapshot()), copy(snapshot())];
    position = 1;
    // One initial entry lets Back close a dialog opened directly from Home.
    win.history.replaceState(marker(0), "");
    win.history.pushState(marker(1), "");
    win.history.scrollRestoration = "manual";
  };
  const visit = change => {
    remember();
    change();
    entries = entries.slice(0, position + 1);
    entries.push(copy(snapshot()));
    position++;
    win.history.pushState(marker(position), "");
  };
  const back = fallback => {
    if (blocked()) return;
    if (dismissOverlay()) return;
    if (position > 1) win.history.back();
    else fallback?.();
  };
  win.addEventListener("popstate", event => {
    const next = event.state?.ksaNavigation;
    if (returning && next?.session === session && next.index === position) {
      returning = false;
      return;
    }
    if (next?.session !== session || !entries[next.index]) {
      // Never restore navigation from a previous authenticated session.
      reset();
      return;
    }
    if (blocked() || dismissOverlay()) {
      returning = true;
      win.history.go(position - next.index);
      return;
    }
    remember();
    position = next.index;
    restore(copy(entries[position]));
  });
  return { reset, visit, remember, back };
}
