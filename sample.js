// The first file on a device with nothing saved and no repository connected.
export const SAMPLE = `// A small story to try the tool. Replace it with your own.
VAR hour = 9
VAR money = 20

-> kitchen

=== kitchen ===
Hour {hour}. RM{money}. The kitchen is quiet.
+ [Go out] -> street
+ {hour < 12} [Wait an hour]
    ~ hour += 1
    -> kitchen

=== street ===
The street is hot already.
+ [Go home] -> kitchen
+ {money >= 5} [Buy a drink]
    ~ money -= 5
    Cold, and worth it.
    -> street
+ [Call it a day] -> END
`;
