// plugins/second-brain/ui/advisory.tsx
import { jsx } from "react/jsx-runtime";
var KIND_BORDER = {
  advisory: "var(--vscode-charts-purple, #b180d7)",
  "turn-report": "var(--vscode-descriptionForeground)",
  "finish-gate": "var(--vscode-charts-orange, #d18616)"
};
function SecondBrainRow({ api }) {
  const marker = api.context.message;
  if (!marker?.text) return null;
  const border = KIND_BORDER[marker.kind] ?? KIND_BORDER["advisory"];
  const dim = marker.kind === "turn-report";
  return /* @__PURE__ */ jsx(
    "div",
    {
      style: {
        borderLeft: `2px solid ${border}`,
        padding: "4px 8px",
        margin: "4px 0",
        whiteSpace: "pre-wrap",
        fontSize: "0.9em",
        opacity: dim ? 0.75 : 1,
        color: "var(--vscode-foreground)"
      },
      children: marker.text
    }
  );
}
export {
  SecondBrainRow as default
};
