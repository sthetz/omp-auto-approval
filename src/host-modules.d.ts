// Packages supplied by the host agent at runtime. OMP maps imports of these
// names to its own bundled copies; on Pi they are optional peer dependencies.
// None are installed for development, so declare them loosely typed here.
declare module "@oh-my-pi/pi-ai";
declare module "@oh-my-pi/pi-tui";
declare module "@earendil-works/pi-ai";
declare module "@earendil-works/pi-tui";
declare module "@earendil-works/pi-coding-agent";
