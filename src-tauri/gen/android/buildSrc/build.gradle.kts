plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        create("pluginsForCoolKids") {
            id = "rust"
            implementationClass = "RustPlugin"
        }
    }
}

repositories {
    google()
    mavenCentral()
}

// The Rust plugin builds against AGP; its classpath stands in gradle.lockfile.
dependencyLocking {
    lockAllConfigurations()
}

dependencies {
    compileOnly(gradleApi())
    implementation("com.android.tools.build:gradle:9.3.1")
}

