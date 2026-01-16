import { render } from "ink";
import React from "react";
import { LogViewer } from "../ui/log-viewer.js";

export const claudeLogs = (sessionId?: string) => {
  render(React.createElement(LogViewer, { sessionId }));
};
