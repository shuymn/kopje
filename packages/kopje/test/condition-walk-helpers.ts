// The most rounds a condition walk (walkedWindow, src/domain/windows.ts) runs for a page, over limits 1 to 40 and 1 to
// 5 streams: derived by test/condition-walk.test.ts (a limit of 1 on one stream: 40, 40, 80, 160, 320, 640, 720).
export const CONDITION_WALK_ROUNDS = 7;
