import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { createPageStory, parameters } from "../createPageStory";

const pageId = "register.ftl";

const { PageStory } = createPageStory({ pageId });

const meta = {
    title: `login/${pageId}`,
    component: PageStory,
    parameters
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: () => <PageStory />
};

export const WithFieldError: Story = {
    render: () => (
        <PageStory
            kcContext={{
                profile: {
                    attributes: [
                        {
                            name: "email",
                            value: "max.mustermann@gmail.com"
                        }
                    ]
                },
                messagesPerField: {
                    existsError: (fieldName: string) => fieldName === "email",
                    exists: (fieldName: string) => fieldName === "email",
                    get: (fieldName: string) => (fieldName === "email" ? "I don't like your email address" : undefined),
                    printIfExists: <T,>(fieldName: string, x: T) => (fieldName === "email" ? x : undefined)
                }
            }}
        />
    )
};

export const WithEmailAsUsername: Story = {
    render: () => (
        <PageStory
            kcContext={{
                realm: {
                    registrationEmailAsUsername: true
                }
            }}
        />
    )
};

export const WithoutPassword: Story = {
    render: () => (
        <PageStory
            kcContext={{
                passwordRequired: false
            }}
        />
    )
};

export const WithRecaptcha: Story = {
    render: () => (
        <PageStory
            kcContext={{
                recaptchaRequired: true,
                recaptchaSiteKey: "foobar"
            }}
        />
    )
};

export const WithPresets: Story = {
    render: () => (
        <PageStory
            kcContext={{
                profile: {
                    attributes: [
                        {
                            name: "firstName",
                            value: "Max"
                        },
                        {
                            name: "lastName",
                            value: "Mustermann"
                        },
                        {
                            name: "email",
                            value: "max.mustermann@gmail.com"
                        },
                        {
                            name: "username",
                            value: "max.mustermann"
                        }
                    ]
                }
            }}
        />
    )
};
