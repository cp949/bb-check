const fixtureState = { value: "syntax fixture" };

export const readFixture = () => fixtureState?.value ?? "missing";
