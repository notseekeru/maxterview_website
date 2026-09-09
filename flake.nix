{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              stripe-cli # Stripe sandbox CLI: `stripe login`, `stripe listen`, `stripe trigger`, ...
              curl # the clerk-stripe-operator scripts shell out to curl
              nodejs # host runtime for the @clerk/testing + Playwright headless Clerk e2e
              playwright # playwright-core (CJS require-able) for the hermetic-e2e host-direct runner
              chromium # GC-safe headless chrome reference; playwright-core drives it via executablePath
            ];
          };
        }
      );
    };
}
