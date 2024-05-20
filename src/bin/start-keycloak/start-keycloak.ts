import { readBuildOptions } from "../shared/buildOptions";
import type { CliCommandOptions as CliCommandOptions_common } from "../main";
import { promptKeycloakVersion } from "../shared/promptKeycloakVersion";
import { readMetaInfKeycloakThemes } from "../shared/metaInfKeycloakThemes";
import {
    accountV1ThemeName,
    skipBuildJarsEnvName,
    containerName
} from "../shared/constants";
import { SemVer } from "../tools/SemVer";
import type { KeycloakVersionRange } from "../shared/KeycloakVersionRange";
import { getJarFileBasename } from "../shared/getJarFileBasename";
import { assert, type Equals } from "tsafe/assert";
import * as fs from "fs";
import {
    join as pathJoin,
    relative as pathRelative,
    sep as pathSep,
    posix as pathPosix
} from "path";
import * as child_process from "child_process";
import chalk from "chalk";
import chokidar from "chokidar";
import { waitForDebounceFactory } from "powerhooks/tools/waitForDebounce";
import { getThisCodebaseRootDirPath } from "../tools/getThisCodebaseRootDirPath";
import { Deferred } from "evt/tools/Deferred";
import { getAbsoluteAndInOsFormatPath } from "../tools/getAbsoluteAndInOsFormatPath";
import cliSelect from "cli-select";
import { isInside } from "../tools/isInside";
import * as runExclusive from "run-exclusive";

export type CliCommandOptions = CliCommandOptions_common & {
    port: number;
    keycloakVersion: string | undefined;
    realmJsonFilePath: string | undefined;
};

export async function command(params: { cliCommandOptions: CliCommandOptions }) {
    exit_if_docker_not_installed: {
        let commandOutput: Buffer | undefined = undefined;

        try {
            commandOutput = child_process.execSync("docker --version", {
                stdio: ["ignore", "pipe", "ignore"]
            });
        } catch {}

        if (commandOutput?.toString("utf8").includes("Docker")) {
            break exit_if_docker_not_installed;
        }

        console.log(
            [
                `${chalk.red("Docker required.")}`,
                `Install it with Docker Desktop: ${chalk.bold.underline(
                    "https://www.docker.com/products/docker-desktop/"
                )}`,
                `(or any other way)`
            ].join(" ")
        );

        process.exit(1);
    }

    exit_if_docker_not_running: {
        let isDockerRunning: boolean;

        try {
            child_process.execSync("docker info", { stdio: "ignore" });
            isDockerRunning = true;
        } catch {
            isDockerRunning = false;
        }

        if (isDockerRunning) {
            break exit_if_docker_not_running;
        }

        console.log(
            [
                `${chalk.red("Docker daemon is not running.")}`,
                `Please start Docker Desktop and try again.`
            ].join(" ")
        );

        process.exit(1);
    }

    const { cliCommandOptions } = params;

    const buildOptions = readBuildOptions({ cliCommandOptions });

    exit_if_theme_not_built: {
        if (fs.existsSync(buildOptions.keycloakifyBuildDirPath)) {
            break exit_if_theme_not_built;
        }

        console.log(
            [
                `${chalk.red("The theme has not been built.")}`,
                `Please run ${chalk.bold("npx vite && npx keycloakify build")} first.`
            ].join(" ")
        );
        process.exit(1);
    }

    const metaInfKeycloakThemes = readMetaInfKeycloakThemes({
        keycloakifyBuildDirPath: buildOptions.keycloakifyBuildDirPath
    });

    const doesImplementAccountTheme = metaInfKeycloakThemes.themes.some(
        ({ name }) => name === accountV1ThemeName
    );

    const { keycloakVersion, keycloakMajorNumber: keycloakMajorVersionNumber } =
        await (async function getKeycloakMajor(): Promise<{
            keycloakVersion: string;
            keycloakMajorNumber: number;
        }> {
            if (cliCommandOptions.keycloakVersion !== undefined) {
                return {
                    keycloakVersion: cliCommandOptions.keycloakVersion,
                    keycloakMajorNumber: SemVer.parse(cliCommandOptions.keycloakVersion)
                        .major
                };
            }

            console.log(
                chalk.cyan("On which version of Keycloak do you want to test your theme?")
            );

            const { keycloakVersion } = await promptKeycloakVersion({
                startingFromMajor: 17,
                cacheDirPath: buildOptions.cacheDirPath
            });

            console.log(`→ ${keycloakVersion}`);

            const keycloakMajorNumber = SemVer.parse(keycloakVersion).major;

            if (doesImplementAccountTheme && keycloakMajorNumber === 22) {
                console.log(
                    [
                        "Unfortunately, Keycloakify themes that implements an account theme do not work on Keycloak 22",
                        "Please select any other Keycloak version"
                    ].join(" ")
                );
                return getKeycloakMajor();
            }

            return { keycloakVersion, keycloakMajorNumber };
        })();

    const keycloakVersionRange: KeycloakVersionRange = (() => {
        if (doesImplementAccountTheme) {
            const keycloakVersionRange = (() => {
                if (keycloakMajorVersionNumber <= 21) {
                    return "21-and-below" as const;
                }

                assert(keycloakMajorVersionNumber !== 22);

                if (keycloakMajorVersionNumber === 23) {
                    return "23" as const;
                }

                return "24-and-above" as const;
            })();

            assert<
                Equals<typeof keycloakVersionRange, KeycloakVersionRange.WithAccountTheme>
            >();

            return keycloakVersionRange;
        } else {
            const keycloakVersionRange = (() => {
                if (keycloakMajorVersionNumber <= 21) {
                    return "21-and-below" as const;
                }

                return "22-and-above" as const;
            })();

            assert<
                Equals<
                    typeof keycloakVersionRange,
                    KeycloakVersionRange.WithoutAccountTheme
                >
            >();

            return keycloakVersionRange;
        }
    })();

    const { jarFileBasename } = getJarFileBasename({ keycloakVersionRange });

    console.log(`Using Keycloak ${chalk.bold(jarFileBasename)}`);

    const mountTargets = buildOptions.themeNames
        .map(themeName => {
            const themeEntry = metaInfKeycloakThemes.themes.find(
                ({ name }) => name === themeName
            );

            assert(themeEntry !== undefined);

            return themeEntry.types
                .map(themeType => {
                    const localPathDirname = pathJoin(
                        buildOptions.keycloakifyBuildDirPath,
                        "src",
                        "main",
                        "resources",
                        "theme",
                        themeName,
                        themeType
                    );

                    return fs
                        .readdirSync(localPathDirname)
                        .filter(
                            fileOrDirectoryBasename =>
                                !fileOrDirectoryBasename.endsWith(".properties")
                        )
                        .map(fileOrDirectoryBasename => ({
                            localPath: pathJoin(
                                localPathDirname,
                                fileOrDirectoryBasename
                            ),
                            containerPath: pathPosix.join(
                                "/",
                                "opt",
                                "keycloak",
                                "themes",
                                themeName,
                                themeType,
                                fileOrDirectoryBasename
                            )
                        }));
                })
                .flat();
        })
        .flat();

    try {
        child_process.execSync(`docker rm --force ${containerName}`, {
            stdio: "ignore"
        });
    } catch {}

    const realmJsonFilePath = await (async () => {
        if (cliCommandOptions.realmJsonFilePath !== undefined) {
            console.log(
                chalk.green(
                    `Using realm json file: ${cliCommandOptions.realmJsonFilePath}`
                )
            );

            return getAbsoluteAndInOsFormatPath({
                pathIsh: cliCommandOptions.realmJsonFilePath,
                cwd: process.cwd()
            });
        }

        const dirPath = pathJoin(
            getThisCodebaseRootDirPath(),
            "src",
            "bin",
            "start-keycloak"
        );

        const filePath = pathJoin(
            dirPath,
            `myrealm-realm-${keycloakMajorVersionNumber}.json`
        );

        if (fs.existsSync(filePath)) {
            return filePath;
        }

        console.log(
            `${chalk.yellow(
                `Keycloakify do not have a realm configuration for Keycloak ${keycloakMajorVersionNumber} yet.`
            )}`
        );

        console.log(chalk.cyan("Select what configuration to use:"));

        const { value } = await cliSelect<string>({
            values: [
                ...fs
                    .readdirSync(dirPath)
                    .filter(fileBasename => fileBasename.endsWith(".json")),
                "none"
            ]
        }).catch(() => {
            process.exit(-1);
        });

        if (value === "none") {
            return undefined;
        }

        return pathJoin(dirPath, value);
    })();

    const spawnArgs = [
        "docker",
        [
            "run",
            ...["-p", `${cliCommandOptions.port}:8080`],
            ...["--name", containerName],
            ...["-e", "KEYCLOAK_ADMIN=admin"],
            ...["-e", "KEYCLOAK_ADMIN_PASSWORD=admin"],
            ...(realmJsonFilePath === undefined
                ? []
                : [
                      "-v",
                      `${realmJsonFilePath}:/opt/keycloak/data/import/myrealm-realm.json`
                  ]),
            ...[
                "-v",
                `${pathJoin(
                    buildOptions.keycloakifyBuildDirPath,
                    jarFileBasename
                )}:/opt/keycloak/providers/keycloak-theme.jar`
            ],
            ...(keycloakMajorVersionNumber <= 20
                ? ["-e", "JAVA_OPTS=-Dkeycloak.profile=preview"]
                : []),
            ...mountTargets
                .map(({ localPath, containerPath }) => [
                    "-v",
                    `${localPath}:${containerPath}:rw`
                ])
                .flat(),
            `quay.io/keycloak/keycloak:${keycloakVersion}`,
            "start-dev",
            ...(21 <= keycloakMajorVersionNumber && keycloakMajorVersionNumber < 24
                ? ["--features=declarative-user-profile"]
                : []),
            ...(realmJsonFilePath === undefined ? [] : ["--import-realm"])
        ],
        {
            cwd: buildOptions.keycloakifyBuildDirPath
        }
    ] as const;

    console.log(JSON.stringify(spawnArgs, null, 2));

    const child = child_process.spawn(...spawnArgs);

    child.stdout.on("data", data => process.stdout.write(data));

    child.stderr.on("data", data => process.stderr.write(data));

    child.on("exit", process.exit);

    const srcDirPath = pathJoin(buildOptions.reactAppRootDirPath, "src");

    {
        const handler = async (data: Buffer) => {
            if (!data.toString("utf8").includes("Listening on: http://0.0.0.0:8080")) {
                return;
            }

            child.stdout.off("data", handler);

            await new Promise(resolve => setTimeout(resolve, 1_000));

            console.log(
                [
                    "",
                    `${chalk.green("Your theme is accessible at:")}`,
                    `${chalk.green("➜")} ${chalk.cyan.bold(
                        "https://my-theme.keycloakify.dev/"
                    )}`,
                    "",
                    "You can login with the following credentials:",
                    `- username: ${chalk.cyan.bold("testuser")}`,
                    `- password: ${chalk.cyan.bold("password123")}`,
                    "",
                    `Keycloak Admin console: ${chalk.cyan.bold(
                        `http://localhost:${cliCommandOptions.port}`
                    )}`,
                    `- user:     ${chalk.cyan.bold("admin")}`,
                    `- password: ${chalk.cyan.bold("admin")}`,
                    "",
                    `Watching for changes in ${chalk.bold(
                        `.${pathSep}${pathRelative(process.cwd(), srcDirPath)}`
                    )}`
                ].join("\n")
            );
        };

        child.stdout.on("data", handler);
    }

    {
        const runBuildKeycloakTheme = runExclusive.build(async () => {
            console.log(chalk.cyan("Detected changes in the theme. Rebuilding ..."));

            {
                const dResult = new Deferred<{ isSuccess: boolean }>();

                const child = child_process.spawn("npx", ["vite", "build"], {
                    cwd: buildOptions.reactAppRootDirPath,
                    env: process.env
                });

                child.stdout.on("data", data => {
                    if (data.toString("utf8").includes("gzip:")) {
                        return;
                    }

                    process.stdout.write(data);
                });

                child.stderr.on("data", data => process.stderr.write(data));

                child.on("exit", code => dResult.resolve({ isSuccess: code === 0 }));

                const { isSuccess } = await dResult.pr;

                if (!isSuccess) {
                    return;
                }
            }

            {
                const dResult = new Deferred<{ isSuccess: boolean }>();

                const child = child_process.spawn("npx", ["keycloakify", "build"], {
                    cwd: buildOptions.reactAppRootDirPath,
                    env: {
                        ...process.env,
                        [skipBuildJarsEnvName]: "true"
                    }
                });

                child.stdout.on("data", data => process.stdout.write(data));

                child.stderr.on("data", data => process.stderr.write(data));

                child.on("exit", code => {
                    if (code !== 0) {
                        console.log(chalk.yellow("Theme not updated, build failed"));
                        return;
                    }

                    console.log(chalk.green("Rebuild done"));
                });

                child.on("exit", code => dResult.resolve({ isSuccess: code === 0 }));

                const { isSuccess } = await dResult.pr;

                if (!isSuccess) {
                    return;
                }
            }
        });

        const { waitForDebounce } = waitForDebounceFactory({ delay: 400 });

        chokidar
            .watch([srcDirPath, getThisCodebaseRootDirPath()], {
                ignoreInitial: true
            })
            .on("all", async (...[, filePath]) => {
                for (const dir1 of ["src", "."]) {
                    for (const dir2 of ["bin", "vite-plugin"]) {
                        if (
                            isInside({
                                dirPath: pathJoin(
                                    getThisCodebaseRootDirPath(),
                                    dir1,
                                    dir2
                                ),
                                filePath
                            })
                        ) {
                            return;
                        }
                    }
                }

                await waitForDebounce();

                runBuildKeycloakTheme();
            });
    }
}
