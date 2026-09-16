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
  // Climbing out of a folder is not the same as going back. The app can restore
  // a folder it remembers — reopening the invoices section lands straight back
  // inside the supplier — and then the level above was never visited and is not
  // behind this entry at all. Where it is, Back is honest and the stack shrinks;
  // where it is not, this entry becomes the level above instead of leaving the
  // section, which is what "חזרה לספקים" promises.
  const up = (behind, change) => {
    if (blocked()) return;
    if (dismissOverlay()) return;
    if (position > 1 && behind(entries[position - 1])) return win.history.back();
    change();
    entries[position] = copy(snapshot());
    win.history.replaceState(marker(position), "");
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
  return { reset, visit, remember, back, up };
}
