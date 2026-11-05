buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
    // AGP, the Kotlin plugin and everything they pull in stand with their
    // versions in buildscript-gradle.lockfile. Rewrite it with
    // `gradlew buildEnvironment --write-locks`.
    configurations.classpath {
        resolutionStrategy.activateDependencyLocking()
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

