/**
 * "Deepen" - asking a Fellow to append to pages the vault already has (docs/agents/ideas.md,
 * decision 2026-09-07).
 *
 * `research-expand` was complete on the server and invisible in the UI, so the one run kind
 * that touches existing pages was the one nobody could ask for. This is the one dialog behind
 * both entry points: the Fellow card, where the domain is the Fellow's own, and the Catalog,
 * where the domain is the filter you are already looking at.
 *
 * You pick the domain; the vault picks the pages. The ranking is `deepenCandidates` - demand
 * against substance - and the dialog only asks you to accept or replace what it proposes.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client.ts";
import { Icon } from "../Icon.tsx";
import { stepButton } from "../../lib/stepAction.ts";
import {
  deepenCandidates,
  deepenCostUsd,
  fellowsForDomain,
  DEEPEN_DEFAULT_PAGES,
  DEEPEN_MAX_PAGES,
  type DeepenCandidate,
} from "../../lib/deepen.ts";
import { SpawnForm } from "./SpawnForm.tsx";

const titleOf = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.md$/, "");

/** Rounded to the unit the numbers deserve: a page is thin or it is not. */
const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} kB`;

export function DeepenDialog({
  domain,
  agentId,
  onClose,
}: {
  /** The domain whose pages are on offer - the Fellow's home, or the Catalog's filter. */
  domain: string;
  /** Preselected Fellow; the dialog still lets you switch when several may take it. */
  agentId?: string;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const graph = useQuery({ queryKey: ["graph"], queryFn: api.graph });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const ranked: DeepenCandidate[] = useMemo(
    () => deepenCandidates(graph.data?.nodes ?? [], domain),
    [graph.data, domain],
  );
  const eligible = useMemo(
    () => fellowsForDomain(agents.data?.fellows ?? [], domain),
    [agents.data, domain],
  );

  /** The set as it stands: the ranking's head until you replace something. */
  const [picked, setPicked] = useState<string[] | null>(null);
  const pages =
    picked ?? ranked.slice(0, DEEPEN_DEFAULT_PAGES).map((c) => c.path);
  const [direction, setDirection] = useState("");
  const [search, setSearch] = useState("");
  /** The daily quota is used up and the dialog is asking whether to run anyway (section 8.4). */
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which Fellow takes it; only asked when more than one may. */
  const [who, setWho] = useState<string | undefined>(agentId);
  /** The domain has no Fellow and the spawn form is open in its place. */
  const [spawning, setSpawning] = useState(false);

  const chosen = eligible.find((f) => f.agent.id === who) ?? eligible[0];
  const factor =
    agents.data?.models.find((m) => m.key === chosen?.agent.model)?.factor ?? 1;
  const step = stepButton(
    {
      used: chosen?.runsTonight ?? 0,
      runsPerDay: chosen?.agent.quotaRunsPerDay ?? 1,
    },
    confirming,
  );

  /** Replacing a row pulls in the next page of the ranking that is not already in the set. */
  const replace = (path: string): void => {
    const rest = pages.filter((p) => p !== path);
    const next = ranked.find((c) => !rest.includes(c.path) && c.path !== path);
    setPicked(next ? [...rest, next.path] : rest);
  };
  const add = (path: string): void => {
    if (pages.includes(path) || pages.length >= DEEPEN_MAX_PAGES) return;
    setPicked([...pages, path]);
    setSearch("");
  };

  const hits =
    search.trim() === ""
      ? []
      : ranked
          .filter(
            (c) =>
              !pages.includes(c.path) &&
              c.title.toLowerCase().includes(search.trim().toLowerCase()),
          )
          .slice(0, 6);

  const deepenWith = async (id: string, override: boolean): Promise<void> => {
    await api.stepAgent(id, {
      kind: "research-expand",
      pageSet: pages,
      ...(direction.trim() ? { topic: direction.trim() } : {}),
      ...(override ? { override: true } : {}),
    });
  };

  const start = useMutation({
    mutationFn: async () => {
      if (chosen === undefined) throw new Error("no Fellow works this domain");
      await deepenWith(chosen.agent.id, step.override);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["library-scene"] });
      void qc.invalidateQueries({ queryKey: ["agent-card", chosen?.agent.id] });
      onClose();
    },
    onError: (err) => {
      // The quota ran out between the render and the click: ask instead of just refusing.
      if (err instanceof ApiError && err.code === "quota") setConfirming(true);
      setError((err as Error).message);
    },
  });

  const rows = pages.map(
    (p) =>
      ranked.find((c) => c.path === p) ?? {
        path: p,
        title: titleOf(p),
        backlinks: 0,
        bytes: 0,
        score: 0,
      },
  );
  const loading = graph.isPending || agents.isPending;

  return (
    <div
      className="dp-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={`Deepen pages in ${domain}`}
      onClick={onClose}
    >
      <div className="dp" onClick={(e) => e.stopPropagation()}>
        <button className="gx-close" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
        <div className="dp-head">
          <div className="gx-kicker">Deepen · {domain}</div>
          <h2 className="gx-title">
            {rows.length} page{rows.length === 1 ? "" : "s"} the vault points at
            and that do not pay off
          </h2>
          <p className="mono-meta">
            An additive run: it writes what it finds into the section it belongs to
            and never rewrites a line, flagging what it contradicts. Ranked by
            backlinks against page size.
          </p>
        </div>

        {loading ? (
          <p className="mono-meta">Reading the vault…</p>
        ) : (
          <>
            {/* Above both branches: spawning a Fellow for this work should show the work. */}
            <ul className="dp-list">
              {rows.map((c) => (
                <li key={c.path}>
                  <span className="dp-t">{c.title}</span>
                  <span className="mono-meta">
                    {c.backlinks} backlink{c.backlinks === 1 ? "" : "s"} ·{" "}
                    {kb(c.bytes)}
                  </span>
                  <button
                    className="dp-x"
                    aria-label={`Replace ${c.title}`}
                    title="Take the next candidate instead"
                    onClick={() => replace(c.path)}
                  >
                    ×
                  </button>
                </li>
              ))}
              {rows.length === 0 && (
                <li className="mono-meta">Nothing in this domain to deepen.</li>
              )}
            </ul>
            {eligible.length === 0 ? (
              <div className="dp-empty">
                <p>
                  No Fellow works <b>{domain}</b>. A Fellow deepens its own
                  ground only, so this domain wants one of its own.
                </p>
                {spawning ? (
                  /*
                   * The spawn form with the domain filled in, and `runFirstStep` off: the new
                   * Fellow's first step is this deepening rather than the usual first research
                   * run, so it begins by consolidating what is there instead of adding beside it.
                   */
                  <SpawnForm
                    prefill={{ homeDomain: domain, runFirstStep: false }}
                    onCancel={() => setSpawning(false)}
                    onDone={(id) => {
                      void deepenWith(id, false)
                        .then(() => {
                          void qc.invalidateQueries({ queryKey: ["agents"] });
                          void qc.invalidateQueries({
                            queryKey: ["library-scene"],
                          });
                          onClose();
                        })
                        .catch((err: unknown) =>
                          setError((err as Error).message),
                        );
                    }}
                  />
                ) : (
                  <button
                    className="btn primary sm"
                    onClick={() => setSpawning(true)}
                  >
                    Spawn a Fellow for {domain}
                  </button>
                )}
                {error !== null && <div className="toast err">{error}</div>}
              </div>
            ) : (
              <>
                {eligible.length > 1 && (
                  <label className="dp-field">
                    <span>Fellow</span>
                    <select
                      value={chosen?.agent.id ?? ""}
                      onChange={(e) => setWho(e.target.value)}
                    >
                      {eligible.map((f) => (
                        <option key={f.agent.id} value={f.agent.id}>
                          {f.agent.name}{" "}
                          {f.agent.homeDomain === domain
                            ? ""
                            : `(${domain} is an extra domain)`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="dp-field">
                  <span>Add a page</span>
                  <input
                    type="search"
                    value={search}
                    placeholder={
                      pages.length >= DEEPEN_MAX_PAGES
                        ? `at most ${DEEPEN_MAX_PAGES} pages`
                        : `search ${domain}…`
                    }
                    disabled={pages.length >= DEEPEN_MAX_PAGES}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                {hits.length > 0 && (
                  <ul className="dp-hits">
                    {hits.map((c) => (
                      <li key={c.path}>
                        <button onClick={() => add(c.path)}>
                          {c.title}{" "}
                          <span className="mono-meta">{kb(c.bytes)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <label className="dp-field">
                  <span>What to look for</span>
                  <input
                    type="text"
                    value={direction}
                    placeholder="optional - empty means the Fellow's own intent steers it"
                    onChange={(e) => setDirection(e.target.value)}
                  />
                </label>

                <p className="mono-meta">
                  Up to {deepenCostUsd(pages.length, factor).toFixed(2)} USD ·{" "}
                  {chosen?.agent.name} · {chosen?.runsTonight} of{" "}
                  {chosen?.agent.quotaRunsPerDay} runs today
                </p>
                {step.note !== null && <p className="mono-meta">{step.note}</p>}
                {error !== null && <div className="toast err">{error}</div>}
                <div className="dp-actions">
                  <button className="btn sm" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className="btn primary sm"
                    disabled={start.isPending || pages.length === 0}
                    onClick={() =>
                      step.asks ? setConfirming(true) : start.mutate()
                    }
                  >
                    {start.isPending
                      ? "Starting…"
                      : step.asks
                        ? step.label
                        : `Deepen ${pages.length} page${pages.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
