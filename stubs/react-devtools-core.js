// Ink 的开发期 devtools 依赖；生产构建中用空桩替换，避免增加体积。
const noop = () => undefined;

export default {
  connectToDevTools: noop,
  initialize: noop,
};

export const connectToDevTools = noop;
export const initialize = noop;
