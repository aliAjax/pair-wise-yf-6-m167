import "./styles.css";
import { loadState, saveState } from "./flow.js";
import { startApp } from "./view.js";

const state = loadState();
startApp(state, saveState);
