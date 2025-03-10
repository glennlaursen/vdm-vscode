let data = require('./jars.json');
const execSync = require('child_process').execSync;
const txml = require('txml');
const fs = require("fs");
const glob = require("glob")

const args = process.argv.slice(2);

if (args.length < 2) {
    throw new Error("Arguments required");
}

let configId = args.find((a) => a.includes("configId=")).slice("configId=".length);
let version = args.find((a) => a.includes("version=")).slice("version=".length);


let jarInfo = data.jars[configId];

if (!jarInfo) {
    throw new Error("No config found.");
}

// Clean old versions of jars
jarInfo.jarDestinations.forEach((dest) => {
    const files = glob.GlobSync(`${dest.destDir}/{${dest.artifactIds},'unused-filename'}-*.jar`).found;

    for (const f of files) {
        console.log('Deleting file: ', f);
        fs.unlinkSync(f);
    }
});

// Download new versions of jars
jarInfo.jarDestinations.forEach((dest) => {
    dest.artifactIds.split(',').forEach(async (artifactId) => {
        if (jarInfo.classifier && jarInfo.classifier.length > 0) {
            downloadWithClassifier(jarInfo.repository, jarInfo.groupId, artifactId, version, jarInfo.classifier, dest.destDir);
        } else {
            download(jarInfo.repository, jarInfo.groupId, artifactId, version, dest.destDir);
        }

    });
});


function download(repository, groupId, artifactId, version, destDir) {
    const output = execSync(`mvn --batch-mode dependency:get \
    -Dartifact=${groupId}:${artifactId}:${version} \
    -DremoteRepositories=github::default::https://maven.pkg.github.com/${repository} \
    -Ddest=${destDir}/${artifactId}-${version}.jar`, { encoding: 'utf-8' });
    console.log(output);
}

async function downloadWithClassifier(repository, groupId, artifactId, version, classifier, destDir) {
    // Workaround for GitHub Packages bug: Maven classifiers with dashes gets split in classifer & extension. https://github.com/orgs/community/discussions/49682

    const groupIdUrl = groupId.replaceAll('.', '/');
    const artifactIdUrl = artifactId.replaceAll('.', '/');

    let urlToPackage;

    if (version.includes("SNAPSHOT")) {

        // Fetch metadata for this version of the package.
        let url = `https://maven.pkg.github.com/${repository}/${groupIdUrl}/${artifactIdUrl}/${version}/maven-metadata.xml`;

        let data = await (fetch(url, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } }).then(response => response.text()).then(str => txml.parse(str)));
        // Parse XML to find timestamp & buildNumber.
        let timestamp = txml.filter(data, (node) => node.tagName.toLowerCase() === 'timestamp')[0].children[0];
        let buildNumber = txml.filter(data, (node) => node.tagName.toLowerCase() === 'buildnumber')[0].children[0];

        let versionNoSnap = version.replace('-SNAPSHOT', '');

        // https://maven.pkg.github.com/glennlaursen/vdm-plantuml-plugin/dk/au/ece/vdmj/uml/0.1.1-SNAPSHOT/uml-0.1.1-20230308.153238-1-jar-with-dependencies.jar
        urlToPackage = `https://maven.pkg.github.com/${repository}/${groupIdUrl}/${artifactIdUrl}/${version}/${artifactIdUrl}-${versionNoSnap}-${timestamp}-${buildNumber}-${classifier}.jar`;

    } else {
        urlToPackage = `https://maven.pkg.github.com/${repository}/${groupIdUrl}/${artifactIdUrl}/${version}/${artifactIdUrl}-${version}-${classifier}.jar`;
    }

    fetch(urlToPackage, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } })
        .then((response) => response.blob())
        .then((blob) => {
            blob.arrayBuffer()
                .then((ab) => fs.writeFileSync(`${destDir}/${artifactId}-${version}-${classifier}.jar`, Buffer.from(ab)));
        });
}