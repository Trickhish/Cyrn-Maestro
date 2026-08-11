import { useCallback, useEffect, useState } from "react";
import { api, type Actor, type Project, type TaskSummary } from "./lib/api";
import { useTheme } from "./lib/useTheme";
import { hashFor, viewFromHash } from "./lib/route";
import { Rail, type View } from "./components/Rail";
import { SignIn } from "./screens/SignIn";
import { ProjectHome } from "./screens/ProjectHome";
import { LiveThread } from "./screens/LiveThread";
import { Fleet } from "./screens/Fleet";

export default function App() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [view, setViewState] = useState<View>(() => viewFromHash(location.hash) ?? { name: "fleet" });
  const [theme, toggleTheme] = useTheme();

  /* Navigation writes the hash; the hash drives the view. That way a pasted
     link, a reload and the back button all land in the same place. */
  const setView = useCallback((next: View) => {
    location.hash = hashFor(next);
    setViewState(next);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = viewFromHash(location.hash);
      if (next) setViewState(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api
      .session()
      .then(({ actor, registrationOpen }) => {
        setActor(actor);
        setRegistrationOpen(registrationOpen);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(async () => {
    const [p, t] = await Promise.all([api.projects(), api.tasks()]);
    setProjects(p.projects);
    setTasks(t.tasks);
    return p.projects;
  }, []);

  useEffect(() => {
    if (!actor) return;

    void refresh().then((list) => {
      /* Land somewhere useful on a bare URL: the first project if there is one,
         otherwise Fleet, which is where a fresh instance needs you first. A
         hash in the URL always wins — it was an explicit request. */
      if (!viewFromHash(location.hash) && list.length > 0) {
        setView({ name: "project", projectId: list[0].id });
      }
    });

    /* Keeps the rail's status glyphs honest without a socket per project. */
    const timer = setInterval(() => void refresh().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [actor, refresh, setView]);

  if (loading) {
    return (
      <div className="h-full grid place-items-center bg-canvas-alt text-faint text-[13px]">
        Loading Maestro…
      </div>
    );
  }

  if (!actor) {
    return <SignIn registrationOpen={registrationOpen} onSignedIn={setActor} />;
  }

  const project =
    view.name === "project" ? projects.find((p) => p.id === view.projectId) : undefined;

  return (
    <div className="h-full flex bg-canvas text-primary">
      <Rail
        actor={actor}
        projects={projects}
        tasks={tasks}
        view={view}
        onNavigate={setView}
        onProjectCreated={(created) => {
          setProjects((list) => [created, ...list]);
          setView({ name: "project", projectId: created.id });
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {view.name === "fleet" && <Fleet />}

      {view.name === "project" &&
        (project ? (
          <ProjectHome
            project={project}
            onOpenTask={(taskId) => setView({ name: "task", taskId })}
          />
        ) : (
          <Empty>That project is gone.</Empty>
        ))}

      {view.name === "task" && (
        <LiveThread
          taskId={view.taskId}
          onBack={() => {
            const task = tasks.find((t) => t.id === view.taskId);
            setView(
              task ? { name: "project", projectId: task.projectId } : { name: "fleet" },
            );
          }}
        />
      )}

      {projects.length === 0 && view.name === "project" && (
        <Empty>Create a project in the rail to get started.</Empty>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 grid place-items-center text-[13px] text-faint">{children}</div>
  );
}
