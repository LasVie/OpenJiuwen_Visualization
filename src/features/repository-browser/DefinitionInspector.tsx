import { ArrowUp, ChevronRight, Code2, GitFork, Layers3 } from "lucide-react";
import type { JsonValue, RegisteredGraphNode } from "../../kernel";
import type { DefinitionGraphIndex } from "./model";

function renderAttribute(value: JsonValue) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="definition-inspector__empty">无</span>;
    return (
      <span className="definition-attribute-list">
        {value.slice(0, 40).map((item, index) => (
          <code key={`${String(item)}:${index}`}>{String(item)}</code>
        ))}
        {value.length > 40 ? <em>+{value.length - 40}</em> : null}
      </span>
    );
  }
  if (value && typeof value === "object") return <code>{JSON.stringify(value)}</code>;
  return <code>{String(value)}</code>;
}

interface DefinitionInspectorProps {
  index: DefinitionGraphIndex;
  node: RegisteredGraphNode;
  focusId: string;
  onNavigate: (nodeId: string) => void;
}

export function DefinitionInspector({
  index,
  node,
  focusId,
  onNavigate,
}: DefinitionInspectorProps) {
  const source = node.evidence.find((evidence) => evidence.source)?.source;
  const children = index.childrenByParent.get(node.id) ?? [];
  const incoming = index.incomingByNode.get(node.id) ?? [];
  const outgoing = index.outgoingByNode.get(node.id) ?? [];
  const attributes = Object.entries(node.attributes ?? {});

  return (
    <aside className="definition-inspector" aria-label="定义节点详情">
      <header className="definition-inspector__header">
        <span>
          <small>SELECTED DEFINITION</small>
          <strong>{node.label}</strong>
        </span>
        <code>{node.kind}</code>
      </header>

      <div className="definition-inspector__scroll">
        <section className="definition-inspector__section">
          <h3><Code2 size={14} />源码证据</h3>
          <p>{node.summary}</p>
          <dl>
            <div><dt>owner</dt><dd>{node.owner}</dd></div>
            <div><dt>path</dt><dd><code>{source?.path ?? "—"}</code></dd></div>
            <div><dt>symbol</dt><dd><code>{source?.symbol ?? "—"}</code></dd></div>
            <div>
              <dt>lines</dt>
              <dd>
                <code>
                  {source?.startLine
                    ? `${source.startLine}${source.endLine ? `–${source.endLine}` : ""}`
                    : "—"}
                </code>
              </dd>
            </div>
            <div><dt>revision</dt><dd><code>{source?.revision?.slice(0, 12) ?? "—"}</code></dd></div>
          </dl>
        </section>

        <section className="definition-inspector__section">
          <h3><Layers3 size={14} />层级</h3>
          <div className="definition-inspector__metrics">
            <span><strong>{children.length}</strong><small>子节点</small></span>
            <span><strong>{incoming.length}</strong><small>入边</small></span>
            <span><strong>{outgoing.length}</strong><small>出边</small></span>
          </div>
          <div className="definition-inspector__actions">
            {node.parentId ? (
              <button type="button" onClick={() => onNavigate(node.parentId!)}>
                <ArrowUp size={14} />进入父层
              </button>
            ) : null}
            {node.id !== focusId ? (
              <button type="button" onClick={() => onNavigate(node.id)}>
                <ChevronRight size={14} />以此节点为中心
              </button>
            ) : null}
          </div>
        </section>

        {attributes.length > 0 ? (
          <section className="definition-inspector__section">
            <h3><GitFork size={14} />静态属性</h3>
            <dl className="definition-inspector__attributes">
              {attributes.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{renderAttribute(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <section className="definition-inspector__section">
          <h3><GitFork size={14} />关系摘要</h3>
          <div className="definition-relation-list">
            {[...incoming, ...outgoing].slice(0, 16).map((edge) => {
              const incomingEdge = edge.target === node.id;
              const peerId = incomingEdge ? edge.source : edge.target;
              const peer = index.nodesById.get(peerId);
              return (
                <button type="button" key={edge.id} onClick={() => onNavigate(peerId)}>
                  <code>{incomingEdge ? "←" : "→"} {edge.kind}</code>
                  <span>{peer?.label ?? peerId}</span>
                </button>
              );
            })}
            {incoming.length + outgoing.length === 0 ? (
              <span className="definition-inspector__empty">当前节点没有可解析关系。</span>
            ) : null}
          </div>
        </section>
      </div>
    </aside>
  );
}
