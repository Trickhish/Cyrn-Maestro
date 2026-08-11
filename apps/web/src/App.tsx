import { useEffect, useState } from "react";
import { Rail } from "./components/Rail";
import { TaskThread } from "./screens/TaskThread";
import { Conductor } from "./screens/Conductor";
import { useLiveRun } from "./lib/useLiveRun";
import { useTheme } from "./lib/useTheme";
import { hashForView, viewFromHash, type View } from "./lib/view";

export default function App() {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));
  const [panelOpen, setPanelOpen] = useState(true);
  const [theme, toggleTheme] = useTheme();
  const live = useLiveRun(true);

  // The hash is the router: two screens, deep-linkable, no dependency.
  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function navigate(next: View) {
    window.location.hash = hashForView(next);
    setView(next);
  }

  // Keyboard-first is a promise the shell has to keep, not just label.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key === "\\") {
        event.preventDefault();
        setPanelOpen((open) => !open);
      }
      if (mod && event.key.toLowerCase() === "j") {
        event.preventDefault();
        navigate(view === "conductor" ? "thread" : "conductor");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  return (
    <div className="h-full flex bg-canvas text-primary">
      <Rail
        view={view}
        onNavigate={navigate}
        inbox={3}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      {view === "thread" ? (
        <TaskThread
          live={live}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((o) => !o)}
        />
      ) : (
        <Conductor
          live={live}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((o) => !o)}
          onOpenThread={() => navigate("thread")}
        />
      )}
    </div>
  );
}
