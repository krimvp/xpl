package jobrunner;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

public final class Config {
    private final Map<String, Map<String, String>> sections = new HashMap<>();
    public static Config loadConfig(Path path) throws IOException { return parseYaml(Files.readString(path)); }
    public static Config parseYaml(String text) {
        Config config = new Config();
        Map<String, String> current = null;
        for (String raw : text.split("\\R")) {
            String line = raw.replaceFirst("(^|\\s)#.*$", "").stripTrailing();
            if (line.isBlank()) continue;
            String[] parts = line.split(":", 2);
            if (parts.length != 2) throw new IllegalArgumentException("expected key: value");
            if (!Character.isWhitespace(line.charAt(0))) {
                if (!parts[1].isBlank()) throw new IllegalArgumentException("section cannot have a value");
                current = new HashMap<>();
                config.sections.put(parts[0].trim(), current);
            } else {
                if (current == null) throw new IllegalArgumentException("key outside section");
                current.put(parts[0].trim(), parts[1].trim());
            }
        }
        return config;
    }
    public String text(String section, String key) {
        String value = sections.getOrDefault(section, Map.of()).get(key);
        if (value == null) throw new IllegalArgumentException("missing " + section + "." + key);
        return value;
    }
    public long number(String section, String key) { return Long.parseLong(text(section, key)); }
    public boolean flag(String section, String key) {
        String value = text(section, key);
        if (!value.equals("true") && !value.equals("false")) throw new IllegalArgumentException("expected boolean");
        return Boolean.parseBoolean(value);
    }
}
