// Part 7 of the specification's checks (./checks.ts says how they are split): its share of the checks of checks.json.
import { tlaTsChecks } from "./checks.js";

tlaTsChecks(import.meta.url);
